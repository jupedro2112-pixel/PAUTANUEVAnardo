#!/bin/bash
# ============================================================================
# clon-ssm-put.sh — Sube los 21 parámetros SSM de la página NUEVA (nardo) a
# /nardo1girox/prod/ — EN LA CUENTA VIEJA (Lautarobaezaws2026, sa-east-1).
#
# ⚠️ CAMBIO DE PLAN (owner 2026-08-07): la página nueva se monta en el Amazon
#    VIEJO (la cuenta nueva no se puede usar). Por eso el path es
#    /nardo1girox/prod/ — SEPARADO del /1girox/prod/ del entorno que ya está
#    en producción. El entorno EB nuevo lleva la env property
#    SSM_PATH=/nardo1girox/prod/ (loadSecrets.js lee de ahí).
#
# ⚠️ ARCHIVO TEMPORAL del runbook docs/MIGRACION-AWS.md (paso 5). Borrar del
#    repo cuando la clonación esté terminada, junto con el runbook.
#
# CÓMO SE USA:
#   1. EDITAR este archivo LOCALMENTE (en Tails) y completar los valores de la
#      sección "COMPLETAR". Los que dicen COMPLETAR_DEL_EXPORT salen del
#      ssm-export.json de ~/Documents/amazonviejo/ (misma cuenta).
#      ⚠️⚠️ NUNCA commitear/pushear este archivo con valores reales: EL REPO ES
#      PÚBLICO. Se edita local, se usa, y listo (Tails lo borra solo).
#   2. CloudShell de la cuenta VIEJA (región sa-east-1) → Actions → Upload file.
#   3. Subir TODO:            bash clon-ssm-put.sh
#      Subir/corregir UNO(s): bash clon-ssm-put.sh GIROX_API_KEY REDIS_URL
#      Ver qué quedó:         bash clon-ssm-put.sh --check
#
#   Re-correrlo es SEGURO: usa --overwrite (pisa el valor con el de acá) y
#   escribe SOLO bajo /nardo1girox/prod/ — jamás toca el /1girox/prod/ vivo
#   (hay un guard que aborta si el prefijo fuera ese).
#   Para MODIFICAR un parámetro más adelante: editar su valor acá y correr
#   `bash clon-ssm-put.sh NOMBRE_DEL_PARAMETRO`.
#
#   Los que estén vacíos o sin completar se SALTEAN con aviso (no rompen nada),
#   así se puede subir por tandas (ej. HGCASH_WEBHOOK_SECRET recién en el paso
#   12 del runbook, cuando el dashboard de hgcash lo genere).
# ============================================================================
set -euo pipefail

REGION="sa-east-1"
PREFIX="/nardo1girox/prod/"
# La cuenta NUEVA (Maiteabigailsosaaws) quedó descartada: si la CloudShell es
# esa, abortamos. La correcta es la VIEJA (Lautarobaezaws2026).
CUENTA_DESCARTADA="220282357357"

# ============================================================================
# COMPLETAR — los 21 valores
# (entre comillas SIMPLES; si el valor tiene una comilla simple, avisar y se
#  ajusta — ninguno de los actuales debería tenerla)
# ============================================================================

# --- COPIAR IGUAL del ssm-export.json (misma cuenta → 8) ---
ANTHROPIC_API_KEY='COMPLETAR_DEL_EXPORT'
FIREBASE_SERVICE_ACCOUNT_JSON_BASE64='COMPLETAR_DEL_EXPORT'
GIROX_API_URL='https://api-1gx.com/api/v1'
GIROX_NETWIN_SCOPE='casino'
AWS_REGION='sa-east-1'
SMS_MASIVO_PASSWORD='COMPLETAR_DEL_EXPORT'
# Al quedar en la MISMA cuenta AWS, las keys de SNS del export SIRVEN tal cual
# (antes había que crear un usuario IAM en la cuenta nueva — ya no).
AWS_ACCESS_KEY_ID='COMPLETAR_DEL_EXPORT'
AWS_SECRET_ACCESS_KEY='COMPLETAR_DEL_EXPORT'

# --- NUEVOS / PROPIOS DE LA PÁGINA NUEVA (13) ---
MONGODB_URI='COMPLETAR_uri_atlas_nueva_CON_nombre_de_base'  # ej: ...mongodb.net/NOMBREBASE?appName=...
# Redis: en la MISMA cuenta se puede reusar el ElastiCache existente con OTRA
# base lógica — /2 (la /1 la usa NUEVOgirox y la /0 quedó de la vieja
# vipcargas; con DB distinta los adapters de Socket.IO NO se cruzan, mismo
# esquema que ya usa NUEVOgirox). Si se prefiere un Redis aparte, crear uno y
# poner su endpoint con /0.
REDIS_URL='COMPLETAR_rediss://ENDPOINT-EXISTENTE:6379/2'
PUBLIC_BASE_URL='COMPLETAR_https://dominio-nuevo'
ADMIN_HOST='COMPLETAR_url-del-entorno-nuevo.sa-east-1.elasticbeanstalk.com'
ALLOWED_ORIGINS='COMPLETAR'  # https://EB-URL,http://EB-URL,https://dominio,https://www.dominio — MINÚSCULAS y con esquema (se compara contra el header Origin tal cual)
GIROX_API_KEY='COMPLETAR_key_1girox_nueva'
GIROX_PLAY_URL='COMPLETAR_url_de_juego_marca_nueva'
HGCASH_API_TOKEN='COMPLETAR_token_hgcash_nuevo'
HGCASH_WEBHOOK_SECRET='COMPLETAR_del_dashboard_hgcash'
JWT_SECRET='AUTOGENERAR'          # dejar AUTOGENERAR = el script crea uno random
JWT_REFRESH_SECRET='AUTOGENERAR'  # ídem
ADMIN_USERNAME='ignite1000'
ADMIN_PASSWORD='COMPLETAR_password_admin_inicial'

# (OMITIDOS a propósito, decisión owner 2026-08-06: META_PIXEL_ID,
#  META_CAPI_ACCESS_TOKEN, FBADS_WEBHOOK_TOKEN, FBADS_WEBHOOK_URL)

# ============================================================================
# De acá para abajo NO hay que tocar nada
# ============================================================================

PARAMS=(
  ANTHROPIC_API_KEY FIREBASE_SERVICE_ACCOUNT_JSON_BASE64 GIROX_API_URL
  GIROX_NETWIN_SCOPE AWS_REGION SMS_MASIVO_PASSWORD
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
  MONGODB_URI REDIS_URL PUBLIC_BASE_URL ADMIN_HOST ALLOWED_ORIGINS
  GIROX_API_KEY GIROX_PLAY_URL HGCASH_API_TOKEN HGCASH_WEBHOOK_SECRET
  JWT_SECRET JWT_REFRESH_SECRET ADMIN_USERNAME ADMIN_PASSWORD
)

# GUARD 1 — jamás escribir sobre el path del entorno VIVO.
if [ "$PREFIX" = "/1girox/prod/" ]; then
  echo "❌ ABORTADO: el prefijo es /1girox/prod/ (el entorno en PRODUCCIÓN). La página nueva va en /nardo1girox/prod/."
  exit 1
fi

# GUARD 2 — cuenta: esto va en la cuenta VIEJA (Lautarobaezaws2026), no en la
# nueva descartada.
CUENTA_ACTUAL=$(aws sts get-caller-identity --query Account --output text)
if [ "$CUENTA_ACTUAL" = "$CUENTA_DESCARTADA" ]; then
  echo "❌ ABORTADO: esta CloudShell es de la cuenta NUEVA ($CUENTA_ACTUAL, Maiteabigailsosaaws) que quedó descartada — la página nueva va en el Amazon VIEJO."
  exit 1
fi
echo "✅ Cuenta $CUENTA_ACTUAL (verificá que sea la VIEJA: Lautarobaezaws2026) — región $REGION — prefijo $PREFIX"

# Modo --check: listar lo que YA está subido y qué falta, sin tocar nada.
if [ "${1:-}" = "--check" ]; then
  echo "— Parámetros presentes en $PREFIX:"
  EXISTENTES=$(aws ssm get-parameters-by-path --path "$PREFIX" --region "$REGION" \
    --query 'Parameters[].Name' --output text | tr '\t' '\n' | sed "s|$PREFIX||" | sort)
  echo "$EXISTENTES" | sed 's/^/   ✔ /'
  echo "— Faltantes (de los 21 esperados):"
  FALTAN=0
  for name in "${PARAMS[@]}"; do
    if ! echo "$EXISTENTES" | grep -qx "$name"; then echo "   ✘ $name"; FALTAN=1; fi
  done
  [ "$FALTAN" = "0" ] && echo "   (ninguno — están los 21) ✅"
  exit 0
fi

# Si se pasaron nombres por argumento, subir SOLO esos.
if [ "$#" -gt 0 ]; then
  SUBIR=("$@")
  for name in "${SUBIR[@]}"; do
    case " ${PARAMS[*]} " in
      *" $name "*) ;;
      *) echo "❌ '$name' no es uno de los 21 parámetros del clon."; exit 1 ;;
    esac
  done
else
  SUBIR=("${PARAMS[@]}")
fi

OK=0; SALTEADOS=()
for name in "${SUBIR[@]}"; do
  value="${!name}"

  # JWT: autogenerar si quedó el placeholder.
  if [ "$value" = "AUTOGENERAR" ]; then
    value=$(openssl rand -hex 64)
    echo "🎲 $name: generado random (128 hex)"
  fi

  # Sin completar o vacío → saltear con aviso.
  if [ -z "$value" ] || [[ "$value" == COMPLETAR* ]]; then
    SALTEADOS+=("$name")
    continue
  fi

  aws ssm put-parameter \
    --region "$REGION" \
    --name "${PREFIX}${name}" \
    --type SecureString \
    --value "$value" \
    --overwrite >/dev/null
  echo "✅ ${PREFIX}${name}"
  OK=$((OK+1))
done

echo ""
echo "Subidos/actualizados: $OK"
if [ "${#SALTEADOS[@]}" -gt 0 ]; then
  echo "⚠️ SALTEADOS (sin valor todavía — completar y re-correr con esos nombres):"
  printf '   - %s\n' "${SALTEADOS[@]}"
fi
echo ""
echo "Verificar con: bash clon-ssm-put.sh --check"
