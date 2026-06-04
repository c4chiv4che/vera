"""
Banking industry tools. Wired into both the voice agent (bidi) and the
text agent (Phase A's main.py) via the manifest at vera.yaml.

These tools call a real CRM deployed in AWS (via Terraform). The
endpoint and API key come from environment variables loaded by main.py
or bidi/server.py before this module is imported.
"""
import os
import json
import urllib.request
import urllib.error
from pathlib import Path

from strands import tool
from dotenv import load_dotenv

# Tools read the CRM endpoint/key at import time, so we load the shared
# .env ourselves (idempotent) instead of relying on import order in the
# calling module. The .env lives at agent/app/vera/.env.
load_dotenv(Path(__file__).parents[2] / ".env")

CRM_ENDPOINT = os.environ.get("CRM_ENDPOINT", "")
CRM_API_KEY = os.environ.get("CRM_API_KEY", "")

PLAZO_MESES = 24


def _get_cliente(dni: str):
    """Consulta el CRM real (API Gateway -> Lambda -> DynamoDB) por DNI.
    Devuelve el dict del cliente, None si no existe (404),
    o {'_error': ...} si hubo un problema de conexión."""
    dni = dni.strip()
    url = f"{CRM_ENDPOINT}/{dni}"
    req = urllib.request.Request(url, headers={"x-api-key": CRM_API_KEY})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        return {"_error": f"El CRM respondió {e.code}"}
    except Exception as e:
        return {"_error": f"No pude conectar con el CRM: {e}"}


@tool
def identificar_cliente(dni: str) -> dict:
    """Valida la identidad de un cliente del banco por su número de DNI,
    consultando el CRM. Debe usarse SIEMPRE antes de consultar datos
    financieros o evaluar un préstamo."""
    cliente = _get_cliente(dni)
    if cliente is None:
        return {"identificado": False, "mensaje": "No encuentro un cliente con ese DNI."}
    if "_error" in cliente:
        return {"identificado": False, "mensaje": cliente["_error"]}
    return {"identificado": True, "dni": cliente["dni"], "nombre": cliente["nombre"]}


@tool
def consultar_perfil_crediticio(dni: str) -> dict:
    """Devuelve el perfil crediticio de un cliente ya identificado desde el CRM:
    ingreso mensual, deuda mensual actual y score crediticio."""
    cliente = _get_cliente(dni)
    if cliente is None:
        return {"error": "Cliente no encontrado. Identificá al cliente primero."}
    if "_error" in cliente:
        return {"error": cliente["_error"]}
    return {
        "nombre": cliente["nombre"],
        "ingreso_mensual": cliente["ingreso_mensual"],
        "deuda_mensual": cliente["deuda_mensual"],
        "credit_score": cliente["credit_score"],
    }


@tool
def evaluar_prestamo(dni: str, monto_solicitado: float) -> dict:
    """Evalúa una solicitud de préstamo aplicando criterios reales de la industria:
    relación deuda-ingreso (DTI) y score crediticio. Consulta el CRM para los datos.
    Calcula el DTI resultante y decide: 'aprobado', 'derivar_a_humano' o 'fuera_de_parametros'."""
    cliente = _get_cliente(dni)
    if cliente is None:
        return {"error": "Cliente no encontrado. Identificá al cliente primero."}
    if "_error" in cliente:
        return {"error": cliente["_error"]}

    ingreso = cliente["ingreso_mensual"]
    deuda = cliente["deuda_mensual"]
    score = cliente["credit_score"]

    cuota_mensual = monto_solicitado / PLAZO_MESES
    deuda_total_mensual = deuda + cuota_mensual
    dti = deuda_total_mensual / ingreso
    dti_pct = round(dti * 100, 1)

    if dti <= 0.36 and score >= 670:
        decision = "aprobado"
        motivo = f"DTI resultante {dti_pct}% (<=36%) y score {score} (>=670). Dentro de parametros de aprobacion automatica."
    elif dti > 0.50 or score < 580:
        decision = "fuera_de_parametros"
        motivo = f"DTI resultante {dti_pct}% o score {score} fuera de los limites aceptables. Requiere intervencion humana."
    else:
        decision = "derivar_a_humano"
        motivo = f"DTI resultante {dti_pct}% (zona 36-50%) o score {score} (zona 580-670). Requiere revision de un analista."

    return {
        "decision": decision,
        "dti_resultante_pct": dti_pct,
        "credit_score": score,
        "cuota_mensual_estimada": round(cuota_mensual, 2),
        "monto_solicitado": monto_solicitado,
        "motivo": motivo,
    }
