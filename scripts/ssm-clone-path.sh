#!/usr/bin/env bash
# ============================================================
# ssm-clone-path.sh — copia TODOS los parámetros de un path SSM a otro.
#
# Uso: se corre en AWS CloudShell (NO en la Tails local) para que los
# secretos nunca salgan de AWS. Copia cada parámetro del path ORIGEN al
# path DESTINO, como SecureString, desencriptando y re-encriptando con la
# KMS default. Idempotente: re-correrlo pisa los del destino (--overwrite).
#
#   1) Editá SRC y DST abajo.
#   2) bash ssm-clone-path.sh --check   # lista qué hay en origen y destino
#   3) bash ssm-clone-path.sh           # copia (pide confirmación)
#
# ⚠️ El DESTINO se sobrescribe. Revisá bien SRC y DST antes de correr.
# ============================================================
set -euo pipefail

# -------- CONFIGURAR --------
SRC="/nardo1girox/prod/"     # path origen (con la barra final)
DST="/NUEVO_PROYECTO/prod/"  # path destino (con la barra final) — EDITAR
REGION="sa-east-1"           # misma región donde viven los parámetros
# ----------------------------

# Normalizar barras finales.
SRC="${SRC%/}/"
DST="${DST%/}/"

if [[ "$SRC" == "$DST" ]]; then
  echo "❌ SRC y DST son iguales. Abortando (no tiene sentido copiar sobre sí mismo)."
  exit 1
fi

echo "Cuenta AWS: $(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo '??')"
echo "Región:     $REGION"
echo "ORIGEN:     $SRC"
echo "DESTINO:    $DST"
echo

# Lista los nombres (sin valores) de un path.
list_names() {
  aws ssm get-parameters-by-path \
    --path "$1" --region "$REGION" --recursive \
    --query 'Parameters[].Name' --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d'
}

if [[ "${1:-}" == "--check" ]]; then
  echo "== Parámetros en ORIGEN =="
  list_names "$SRC" | sed "s#^$SRC##" | sort
  echo
  echo "== Parámetros en DESTINO =="
  list_names "$DST" | sed "s#^$DST##" | sort
  exit 0
fi

# Traer nombres del origen.
mapfile -t NAMES < <(aws ssm get-parameters-by-path \
  --path "$SRC" --region "$REGION" --recursive \
  --query 'Parameters[].Name' --output text | tr '\t' '\n' | sed '/^$/d')

if [[ "${#NAMES[@]}" -eq 0 ]]; then
  echo "❌ No hay parámetros en $SRC (¿path o región equivocados?)."
  exit 1
fi

echo "Se van a copiar ${#NAMES[@]} parámetros de $SRC → $DST"
read -r -p "¿Confirmás? (escribí SI): " ok
[[ "$ok" == "SI" ]] || { echo "Cancelado."; exit 0; }

copied=0
for name in "${NAMES[@]}"; do
  key="${name#$SRC}"                     # nombre relativo (sin el path)
  dstname="${DST}${key}"
  # Traer el valor DESENCRIPTADO (SecureString) o plano.
  val="$(aws ssm get-parameter --name "$name" --region "$REGION" --with-decryption \
         --query 'Parameter.Value' --output text)"
  aws ssm put-parameter \
    --name "$dstname" --region "$REGION" \
    --type SecureString --value "$val" --overwrite >/dev/null
  echo "  ✓ $key"
  copied=$((copied+1))
done

echo
echo "✅ Copiados $copied parámetros a $DST"
echo "⚠️ Ahora en el entorno NUEVO seteá SSM_PATH=$DST y ajustá lo propio del"
echo "   proyecto nuevo: MONGODB_URI, PUBLIC_BASE_URL, ALLOWED_ORIGINS,"
echo "   JWT_SECRET/JWT_REFRESH_SECRET (regeneralos), REDIS_URL, dominios y keys."
