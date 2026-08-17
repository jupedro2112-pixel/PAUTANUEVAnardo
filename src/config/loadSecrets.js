/**
 * loadSecrets.js
 *
 * Carga parámetros desde AWS Systems Manager Parameter Store y los setea
 * como variables de entorno (process.env) antes de que el resto de la app
 * los lea.
 *
 * Si SSM_PATH no está definido (modo Render / dev local), no hace nada y
 * deja que dotenv / las env vars del proceso ya estén disponibles.
 *
 * El cliente SSM usa el IAM Role del EC2 automáticamente cuando no hay
 * Access Keys explícitas en el entorno.
 */

const { SSMClient, GetParametersByPathCommand } = require('@aws-sdk/client-ssm');

async function loadSecretsFromSSM() {
    const ssmPath = process.env.SSM_PATH;
    if (!ssmPath) {
        console.log('[SSM] SSM_PATH no definido, saltando carga desde Parameter Store (modo .env local)');
        return;
    }

    const region = process.env.AWS_REGION || 'sa-east-1';
    const ssm = new SSMClient({ region });

    // SSM_SKIP_KEYS: claves que NO se sobreescriben desde SSM (2026-08-17). Sirve
    // para un ENTORNO CLON que comparte el mismo SSM_PATH que producción pero
    // necesita SU propia DB / URL: se setean esas claves como PROPIEDADES DE
    // ENTORNO en el clon y se listan acá para que SSM no las pise. Producción no
    // define SSM_SKIP_KEYS → comportamiento idéntico al de siempre (cero riesgo).
    // Ej. clon: SSM_SKIP_KEYS=MONGODB_URI,PUBLIC_BASE_URL
    const skipKeys = (process.env.SSM_SKIP_KEYS || '')
        .split(',').map((s) => s.trim()).filter(Boolean);

    let nextToken;
    let count = 0;
    let skipped = 0;

    try {
        do {
            const response = await ssm.send(new GetParametersByPathCommand({
                Path: ssmPath,
                WithDecryption: true,
                Recursive: false,
                MaxResults: 10,
                NextToken: nextToken
            }));

            for (const param of response.Parameters || []) {
                const key = param.Name.replace(ssmPath, '').replace(/^\/+/, '');
                if (!key) continue;
                if (skipKeys.includes(key)) {
                    skipped++;
                    continue; // conserva la env del entorno (no la pisa SSM)
                }
                process.env[key] = param.Value;
                count++;
            }

            nextToken = response.NextToken;
        } while (nextToken);

        console.log(`[SSM] Cargados ${count} parámetros desde ${ssmPath}` +
            (skipped ? ` (${skipped} NO sobrescritos por SSM_SKIP_KEYS: ${skipKeys.join(', ')})` : ''));
    } catch (err) {
        console.error('[SSM] Error cargando parámetros desde Parameter Store:', err.message);
        throw err;
    }
}

module.exports = { loadSecretsFromSSM };
