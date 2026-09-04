#!/usr/bin/env bash
# ============================================================================
# aws-bootstrap-clone.sh — RECONSTRUYE el entorno en la CUENTA NUEVA a partir
# del clon-export.tar.gz de aws-export-config.sh. Se corre en el CloudShell de
# la cuenta NUEVA, por ETAPAS (cada una re-ejecutable):
#
#   bash aws-bootstrap-clone.sh iam                    # rol de instancia (5 policies)
#   bash aws-bootstrap-clone.sh ssm  /nardo1girox/prod/
#   bash aws-bootstrap-clone.sh redis                  # ElastiCache t4g.micro TLS
#   bash aws-bootstrap-clone.sh cert tudominio.com     # ACM → imprime el CNAME p/ Cloudflare
#   bash aws-bootstrap-clone.sh eb   APP ENV /nardo1girox/prod/ https://tudominio.com
#   bash aws-bootstrap-clone.sh status ENV
#
# Antes: subir clon-export.tar.gz (Actions → Upload file) y `tar xzf clon-export.tar.gz`.
# Lo que NO hace (manual, ver runbook docs/MIGRACION-AWS.md):
#   crear la cuenta AWS / tarjeta · caso de soporte SNS para SMS (cuenta nueva
#   arranca en sandbox $1) · pegar el CNAME del cert en Cloudflare · apuntar el
#   dominio al ALB nuevo · allowlist de IPs en MongoDB Atlas · webhook de hgcash
#   a la URL nueva · REDIS_URL y PUBLIC_BASE_URL nuevos en el SSM importado.
# ============================================================================
set -euo pipefail
REGION="${AWS_REGION:-sa-east-1}"
STEP="${1:?Etapas: iam | ssm | redis | cert | eb | status}"; shift || true
D=clon-export

case "$STEP" in
iam)
  PROFILE=aws-elasticbeanstalk-ec2-role
  aws iam create-role --role-name "$PROFILE" --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' 2>/dev/null || echo "rol ya existe"
  for P in AmazonSNSFullAccess AmazonSSMReadOnlyAccess AWSElasticBeanstalkMulticontainerDocker AWSElasticBeanstalkWebTier AWSElasticBeanstalkWorkerTier; do
    aws iam attach-role-policy --role-name "$PROFILE" --policy-arn "arn:aws:iam::aws:policy/$P"
  done
  aws iam create-instance-profile --instance-profile-name "$PROFILE" 2>/dev/null || true
  aws iam add-role-to-instance-profile --instance-profile-name "$PROFILE" --role-name "$PROFILE" 2>/dev/null || true
  echo "✅ instance profile $PROFILE listo (5 policies)";;

ssm)
  DST="${1:?Falta el path destino, ej /nardo1girox/prod/}"; DST="${DST%/}/"
  python3 - "$D/ssm.json" "$DST" <<'PY' > /tmp/ssm-cmds.sh
import json, sys, shlex
params = json.load(open(sys.argv[1]))['Parameters']; dst = sys.argv[2]
for p in params:
    name = dst + p['Name'].split('/')[-1]
    print(f"aws ssm put-parameter --name {shlex.quote(name)} --type SecureString --overwrite --value {shlex.quote(p['Value'])}")
print(f"echo '✅ {len(params)} parámetros importados a {dst}'")
PY
  bash /tmp/ssm-cmds.sh; rm -f /tmp/ssm-cmds.sh
  echo "⚠️ Revisá y ACTUALIZÁ a mano: REDIS_URL (el endpoint nuevo de la etapa redis),"
  echo "   PUBLIC_BASE_URL (dominio nuevo), JWT_SECRET/JWT_REFRESH_SECRET si querés rotarlos.";;

redis)
  aws elasticache create-cache-cluster --cache-cluster-id clon-redis-node \
    --engine redis --engine-version 7.1 --cache-node-type cache.t4g.micro \
    --num-cache-nodes 1 --transit-encryption-enabled --region "$REGION" 2>/dev/null || echo "cluster ya existe"
  echo "⏳ esperá 'available' y sacá el endpoint:"
  echo "   aws elasticache describe-cache-clusters --cache-cluster-id clon-redis-node --show-cache-node-info --query 'CacheClusters[0].CacheNodes[0].Endpoint' --region $REGION"
  echo "   → REDIS_URL = rediss://<endpoint>:6379/0 (actualizar en SSM)"
  echo "⚠️ Después de crear el entorno EB: abrir 6379 en el SG del Redis desde el SG de las instancias.";;

cert)
  DOMAIN="${1:?Falta el dominio, ej vipcargas.com}"
  ARN=$(aws acm request-certificate --domain-name "$DOMAIN" \
    --subject-alternative-names "www.$DOMAIN" --validation-method DNS \
    --region "$REGION" --query CertificateArn --output text)
  echo "ARN: $ARN"; sleep 5
  aws acm describe-certificate --certificate-arn "$ARN" --region "$REGION" \
    --query 'Certificate.DomainValidationOptions[].ResourceRecord' --output table
  echo "👉 Pegá ese CNAME en Cloudflare (DNS only) y esperá ISSUED:"
  echo "   aws acm describe-certificate --certificate-arn $ARN --region $REGION --query Certificate.Status";;

eb)
  APP="${1:?APP}"; ENVNAME="${2:?ENV}"; SSMP="${3:?SSM_PATH}"; BASEURL="${4:?PUBLIC_BASE_URL}"
  CERT_ARN="${CERT_ARN:-}"  # export CERT_ARN=arn:aws:acm:... antes de correr
  STACK=$(python3 -c "import json;print(json.load(open('$D/meta.json'))['SolutionStackName'])")
  # La rama exacta puede no existir en la cuenta nueva → usar la última de Node.js AL2023.
  AVAIL=$(aws elasticbeanstalk list-available-solution-stacks --region "$REGION" \
    --query 'SolutionStacks' --output json | python3 -c "
import json,sys; ss=json.load(sys.stdin)
node=[s for s in ss if 'Node.js' in s and 'Amazon Linux 2023' in s]
print(node[0] if node else '$STACK')")
  echo "Stack: $AVAIL"
  aws elasticbeanstalk create-application --application-name "$APP" --region "$REGION" 2>/dev/null || echo "app ya existe"
  python3 - "$D/option-settings.json" "$SSMP" "$BASEURL" "$CERT_ARN" <<'PY' > /tmp/opts.json
import json, sys
opts = json.load(open(sys.argv[1])); ssmp, base, cert = sys.argv[2], sys.argv[3], sys.argv[4]
def setopt(ns, name, val):
    for o in opts:
        if o['Namespace'] == ns and o['OptionName'] == name: o['Value'] = val; return
    opts.append({'Namespace': ns, 'OptionName': name, 'Value': val})
setopt('aws:elasticbeanstalk:application:environment', 'SSM_PATH', ssmp)
setopt('aws:elasticbeanstalk:application:environment', 'PUBLIC_BASE_URL', base)
setopt('aws:autoscaling:launchconfiguration', 'IamInstanceProfile', 'aws-elasticbeanstalk-ec2-role')
if cert:
    setopt('aws:elbv2:listener:443', 'SSLCertificateArns', cert)
    setopt('aws:elbv2:listener:443', 'Protocol', 'HTTPS')
else:
    opts = [o for o in opts if o['Namespace'] != 'aws:elbv2:listener:443']
json.dump(opts, open('/tmp/opts.json','w'))
print(f"{len(opts)} option-settings", file=sys.stderr)
PY
  aws elasticbeanstalk create-environment --application-name "$APP" \
    --environment-name "$ENVNAME" --solution-stack-name "$AVAIL" \
    --option-settings file:///tmp/opts.json --region "$REGION" \
    --query '{Env:EnvironmentName,Status:Status,URL:CNAME}' --output table
  echo "⏳ 10-15 min. Cuando esté Ready: subir el ZIP del repo (consola → Upload and deploy)."
  echo "   Después: SG del Redis (6379 desde el SG nuevo) + dominio en Cloudflare → CNAME del entorno.";;

status)
  ENVNAME="${1:?ENV}"
  aws elasticbeanstalk describe-environments --environment-names "$ENVNAME" --region "$REGION" \
    --query 'Environments[0].{Status:Status,Health:Health,URL:CNAME}' --output table;;
*) echo "Etapa desconocida: $STEP"; exit 1;;
esac
