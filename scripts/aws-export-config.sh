#!/usr/bin/env bash
# ============================================================================
# aws-export-config.sh — EXPORTA todo lo replicable del entorno EB actual.
# Se corre en el CloudShell de la CUENTA VIEJA (región del entorno). Genera
# UN archivo: clon-export.tar.gz — que se descarga (Actions → Download file)
# y se sube al CloudShell de la CUENTA NUEVA para aws-bootstrap-clone.sh.
#
#   bash aws-export-config.sh /1girox/prod/ paginaaaacreada NUEVOgirox
#                              ^SSM_PATH     ^EB app         ^EB env
#
# ⚠️ El tar.gz CONTIENE LOS SECRETOS (SSM desencriptado). No sale de AWS salvo
#    el download directo tuyo. NUNCA subirlo al repo (es público).
# ============================================================================
set -euo pipefail
SSM_PATH="${1:?Uso: bash aws-export-config.sh /path/ssm/ APP ENV}"
EB_APP="${2:?Falta el nombre de la app EB}"
EB_ENV="${3:?Falta el nombre del environment EB}"
REGION="${AWS_REGION:-sa-east-1}"
OUT=clon-export; rm -rf "$OUT"; mkdir -p "$OUT"

echo "== 1/4 SSM ($SSM_PATH) =="
aws ssm get-parameters-by-path --path "$SSM_PATH" --recursive --with-decryption \
  --region "$REGION" --output json > "$OUT/ssm.json"
echo "   $(python3 -c "import json;print(len(json.load(open('$OUT/ssm.json'))['Parameters']))") parámetros"

echo "== 2/4 Config del environment EB =="
aws elasticbeanstalk describe-configuration-settings \
  --application-name "$EB_APP" --environment-name "$EB_ENV" \
  --region "$REGION" --output json > "$OUT/eb-config.json"

echo "== 3/4 Metadata (plataforma / tier) =="
aws elasticbeanstalk describe-environments --environment-names "$EB_ENV" \
  --region "$REGION" --output json > "$OUT/eb-env.json"

echo "== 4/4 Filtrando option-settings reutilizables =="
python3 - "$OUT" <<'PY'
import json, sys
out = sys.argv[1]
cfg = json.load(open(f'{out}/eb-config.json'))['ConfigurationSettings'][0]
DROP_NS = ('aws:cloudformation', 'aws:elasticbeanstalk:environment:process')  # se regeneran
# Se excluyen valores atados a la cuenta vieja (el bootstrap pone los nuevos):
DROP_KEYS = {('aws:autoscaling:launchconfiguration','IamInstanceProfile'),
             ('aws:autoscaling:launchconfiguration','EC2KeyName'),
             ('aws:autoscaling:launchconfiguration','SecurityGroups'),
             ('aws:ec2:vpc','VPCId'), ('aws:ec2:vpc','Subnets'), ('aws:ec2:vpc','ELBSubnets'),
             ('aws:elasticbeanstalk:environment','ServiceRole'),
             ('aws:elbv2:listener:443','SSLCertificateArns')}
keep = []
for o in cfg['OptionSettings']:
    ns, opt = o.get('Namespace',''), o.get('OptionName','')
    if any(ns.startswith(d) for d in DROP_NS): continue
    if (ns, opt) in DROP_KEYS: continue
    if 'Value' not in o or o['Value'] in (None, ''): continue
    keep.append({'Namespace': ns, 'OptionName': opt, 'Value': o['Value']})
json.dump(keep, open(f'{out}/option-settings.json','w'), indent=1)
meta = {'SolutionStackName': cfg.get('SolutionStackName'), 'SsmPath': None}
json.dump(meta, open(f'{out}/meta.json','w'), indent=1)
print(f"   {len(keep)} option-settings guardadas · stack: {cfg.get('SolutionStackName')}")
PY

tar czf clon-export.tar.gz "$OUT"; rm -rf "$OUT"
echo; echo "✅ Listo: clon-export.tar.gz — descargalo (Actions → Download file: clon-export.tar.gz)"
echo "   Contiene secretos: NO subirlo a ningún repo."
