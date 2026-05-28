import os
import json
import urllib.request
import urllib.error
# Suppress OpenTelemetry warnings during local development; remove for production
if os.getenv("LOCAL_DEV") == "1":
    os.environ["OTEL_SDK_DISABLED"] = "true"
import uvicorn
from dotenv import load_dotenv
from strands import Agent, tool
from ag_ui_strands import StrandsAgent, StrandsAgentConfig, create_strands_app
from model.load import load_model
from memory.session import get_memory_session_manager

# Load CRM_ENDPOINT and CRM_API_KEY from .env (gitignored)
load_dotenv()

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


tools = [identificar_cliente, consultar_perfil_crediticio, evaluar_prestamo]

SYSTEM_PROMPT = """Sos Vera, la asistente virtual por voz de un banco. Atendés a clientes por teléfono.

Tono: cálida, clara y profesional. Hablás en español rioplatense (de vos). Tus respuestas son
BREVES y conversacionales, como en una llamada telefónica real: una o dos frases por turno.
NUNCA uses listas, viñetas ni texto largo: hablás, no escribís un documento.

Reglas de negocio:
- Antes de dar cualquier información financiera o evaluar un préstamo, SIEMPRE identificá al
  cliente con la herramienta identificar_cliente (pedile el DNI).
- Cuando un cliente quiera un préstamo, usá evaluar_prestamo. NO calcules vos los números:
  confiá en lo que devuelve la herramienta.
- Si la decisión es 'aprobado', comunicáselo con alegría.
- Si es 'derivar_a_humano' o 'fuera_de_parametros', explicá con tacto y empatía que su caso
  necesita la revisión de un analista, y que lo vas a derivar con una persona. No uses jerga
  técnica como 'DTI' con el cliente; explicalo en palabras simples.
- Si una herramienta devuelve un error de conexión, disculpate y pedile al cliente que aguarde
  un momento o intente de nuevo. Nunca inventes datos del cliente."""

agent = Agent(
    model=load_model(),
    system_prompt=SYSTEM_PROMPT,
    tools=tools,
)

def session_manager_provider(input_data):
    return get_memory_session_manager(input_data.thread_id, "default-user")

config = StrandsAgentConfig(session_manager_provider=session_manager_provider)
agui_agent = StrandsAgent(agent=agent, name="vera", description="Asistente bancaria por voz", config=config)
app = create_strands_app(agui_agent, path="/invocations", ping_path="/ping")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
