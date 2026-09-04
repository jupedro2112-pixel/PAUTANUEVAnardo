# Clonación a cuenta AWS nueva vía EC2 — paso a paso para novato

> Objetivo: replicar el entorno EB en una cuenta AWS NUEVA **sin ninguna
> conexión técnica** entre cuentas. El único puente es UN archivo que viaja por
> tu computadora. La app nueva se llama **PAUTANUEVAnardo**.
> Scripts: `scripts/aws-export-config.sh` y `scripts/aws-bootstrap-clone.sh`.

## PARTE A — Cuenta VIEJA (sacar la foto y chau)

1. Entrá a la consola de la cuenta vieja → región **São Paulo (sa-east-1)**.
2. Abrí **CloudShell** (ícono `>_` arriba a la derecha).
3. **Anotá los dos nombres** (sin tocar nada): buscador de la consola →
   **Elastic Beanstalk** → menú izquierdo **Environments** → buscá la fila cuya
   **URL** es `pauta.sa-east-1.elasticbeanstalk.com` (la misma del panel admin
   de ESTE proyecto). De esa fila anotá **Environment name** y **Application
   name** tal cual están escritos.
4. Pegá (trae los scripts del repo, que es público):
   ```bash
   git clone https://github.com/jupedro2112-pixel/PAUTANUEVAnardo.git
   cd PAUTANUEVAnardo
   ```
5. Exportá TODO (SSM + config del entorno), reemplazando por los nombres del
   paso 3. ⚠️ El path SSM de ESTE proyecto es **`/nardo1girox/prod/`**
   (el `/1girox/prod/` es de la OTRA página — no confundir):
   ```bash
   bash scripts/aws-export-config.sh /nardo1girox/prod/ NOMBRE_APPLICATION NOMBRE_ENVIRONMENT
   ```
6. Descargá el resultado: **Actions → Download file** → escribí
   `PAUTANUEVAnardo/clon-export.tar.gz`. Queda en tu PC.
   ⚠️ Ese archivo tiene TODOS los secretos. No lo subas a ningún repo ni lo
   dejes dando vueltas: se usa en la Parte B y se borra.
7. Listo con la cuenta vieja. Cerrá sesión. No se vuelve a tocar.

## PARTE B — Cuenta NUEVA, preparación (todo por consola web)

> Consejo de separación: entrá a cada consola desde perfiles de navegador
> DISTINTOS (o ventanas privadas separadas), no con las dos sesiones en las
> mismas pestañas.

**B1. Rol para la máquina de trabajo**
1. IAM → Roles → **Create role**.
2. Trusted entity: **AWS service** → **EC2** → Next.
3. Policy: buscar **AdministratorAccess** → tildar → Next.
4. Nombre: `ec2-bootstrap` → Create role.

**B2. La máquina (EC2)**
1. Región **sa-east-1** → EC2 → **Launch instance**.
2. Nombre: `bootstrap`. AMI: **Amazon Linux 2023**. Tipo: **t3.micro**.
3. Key pair: **Proceed without a key pair**.
4. Network settings: dejar default (Allow SSH puede quedar).
5. **Advanced details** → IAM instance profile: **ec2-bootstrap**.
6. Launch instance. Esperar "Running".
   - Si falla con *"account pending verification"* → la cuenta aún no está
     activada para EC2: esperar 24-48 h y reintentar (mismo bloqueo que CloudShell).

**B3. El archivo (S3)**
1. S3 → **Create bucket** → nombre único, ej. `clon-tmp-83942` (sa-east-1) → Create.
2. Entrar al bucket → **Upload** → agregar `clon-export.tar.gz` desde tu PC → Upload.

## PARTE C — Construir (terminal en el navegador)

1. EC2 → instancia `bootstrap` → **Connect** → pestaña **EC2 Instance Connect**
   → Connect. Se abre una terminal negra en el navegador.
2. Pegá una línea por vez (cambiá `clon-tmp-83942` por tu bucket):
   ```bash
   export AWS_REGION=sa-east-1
   sudo dnf install -y git
   git clone https://github.com/jupedro2112-pixel/PAUTANUEVAnardo.git
   cd PAUTANUEVAnardo
   aws s3 cp s3://clon-tmp-83942/clon-export.tar.gz .
   tar xzf clon-export.tar.gz
   ```
3. Etapas (una por vez, mirando que cada una termine bien):
   ```bash
   bash scripts/aws-bootstrap-clone.sh iam
   bash scripts/aws-bootstrap-clone.sh ssm /pautanuevanardo/prod/
   bash scripts/aws-bootstrap-clone.sh redis
   ```
4. **Certificado** (solo si ya tenés el dominio nuevo decidido):
   ```bash
   bash scripts/aws-bootstrap-clone.sh cert TUDOMINIO.com
   ```
   Te imprime un CNAME → pegalo en el DNS (Cloudflare, nube gris) → esperá
   que el status dé `ISSUED` (el propio output te deja el comando para chequear).
5. **El entorno** (acá va el NOMBRE NUEVO — app `PAUTANUEVAnardo`):
   ```bash
   export CERT_ARN=arn:aws:acm:...        # el ARN del paso 4; si no hay cert, salteá esta línea
   bash scripts/aws-bootstrap-clone.sh eb PAUTANUEVAnardo PAUTANUEVAnardo-env /pautanuevanardo/prod/ https://TUDOMINIO.com
   ```
   Sin `CERT_ARN`, el entorno se crea solo con HTTP (el HTTPS se agrega después
   desde la consola cuando el cert esté).
6. Estado: `bash scripts/aws-bootstrap-clone.sh status PAUTANUEVAnardo-env`
   (10-15 min hasta Ready).

## PARTE D — Terminar a mano (consola de la cuenta nueva)

1. **Redis:** ElastiCache → `clon-redis-node` → copiar el endpoint.
   SSM → Parameter Store → `/pautanuevanardo/prod/REDIS_URL` → Edit →
   `rediss://<endpoint>:6379/0`.
2. **PUBLIC_BASE_URL** en SSM → `https://TUDOMINIO.com`.
3. **SNS:** no se activa (decisión owner). Dejar los parámetros de SMS en `off`
   — el retiro no exige SMS (#225), nada se rompe.
4. **Security group del Redis:** ElastiCache → SG del cluster → Inbound rule:
   puerto 6379, origen = SG de las instancias del entorno nuevo.
5. **Deploy:** EB → PAUTANUEVAnardo-env → **Upload and deploy** → el ZIP del
   repo de siempre.
6. **Dominio:** Cloudflare → CNAME del dominio → el CNAME del entorno
   (xxxx.sa-east-1.elasticbeanstalk.com). Y regla WAF Skip para
   `/api/hgcash/webhook` si va proxied.
7. **hgcash:** cambiar la URL del webhook a la nueva en su dashboard.
8. **MongoDB Atlas:** si el allowlist no es 0.0.0.0/0, agregar las IPs nuevas.
9. **LIMPIEZA:** terminar la instancia EC2 `bootstrap`, borrar el bucket
   `clon-tmp-*`, borrar el rol `ec2-bootstrap`. Borrar `clon-export.tar.gz`
   de tu PC.

## ¿Riesgo de que conecte las cuentas, así?

**Por el método: NO.** Cero llamadas de API entre cuentas; AWS solo ve un
tar.gz subido por navegador (no correlaciona contenido de archivos ni valores
de SSM). Lo que SÍ vincula cuentas es lo de siempre, independiente del método:
- **Tarjeta / identidad / teléfono / email** de registro (el vector fuerte).
- **Misma IP / mismo navegador** logueado en las dos consolas (usar perfiles
  o ventanas separadas; idealmente no el mismo día desde la misma IP).
- **El mismo DOMINIO** en las dos cuentas (ACM sabe qué dominios certificás):
  si la separación importa de verdad, el clon debería usar dominio nuevo.
