import os
# Suppress OpenTelemetry warnings during local development; remove for production
if os.getenv("LOCAL_DEV") == "1":
    os.environ["OTEL_SDK_DISABLED"] = "true"
import uvicorn
from strands import Agent, tool
from ag_ui_strands import StrandsAgent, StrandsAgentConfig, create_strands_app
from model.load import load_model
from memory.session import get_memory_session_manager

# --- Datos provisorios (luego se reemplazan por el CRM real vía HTTP) ---
# DTI = (deuda_mensual + cuota_nuevo_prestamo) / ingreso_mensual
CLIENTES = {
    "28456789": {
        "nombre": "Raúl Gómez",
        "ingreso_mensual": 2000,
        "deuda_mensual": 600,      # ya destina 600/mes a deudas → DTI base 30%
        "credit_score": 690,
    },
    "31234567": {
        "nombre": "Laura Fernández",
        "ingreso_mensual": 5000,
        "deuda_mensual": 500,      # DTI base 10% → perfil sólido
        "credit_score": 740,
    },
    "20111222": {
        "nombre": "Diego Sosa",
        "ingreso_mensual": 1800,
        "deuda_mensual": 950,      # DTI base ya alto (53%) → fuera de parámetros
        "credit_score": 560,
    },
}

# Plazo estándar para estimar la cuota mensual del préstamo (24 meses, sin interés para simplificar la demo)
PLAZO_MESES = 24


@tool
def identificar_cliente(dni: str) -> dict:
    """Valida la identidad de un cliente del banco por su número de DNI.
    Debe usarse SIEMPRE antes de consultar datos financieros o evaluar un préstamo.
    Devuelve si el cliente fue identificado y su nombre."""
    cliente = CLIENTES.get(dni.strip())
    if not cliente:
        return {"identificado": False, "mensaje": "No encuentro un cliente con ese DNI."}
    return {"identificado": True, "dni": dni.strip(), "nombre": cliente["nombre"]}


@tool
def consultar_perfil_crediticio(dni: str) -> dict:
    """Devuelve el perfil crediticio de un cliente ya identificado:
    ingreso mensual, deuda mensual actual y score crediticio.
    Requiere que el cliente haya sido identificado primero."""
    cliente = CLIENTES.get(dni.strip())
    if not cliente:
        return {"error": "Cliente no encontrado. Identificá al cliente primero."}
    return {
        "nombre": cliente["nombre"],
        "ingreso_mensual": cliente["ingreso_mensual"],
        "deuda_mensual": cliente["deuda_mensual"],
        "credit_score": cliente["credit_score"],
    }


@tool
def evaluar_prestamo(dni: str, monto_solicitado: float) -> dict:
    """Evalúa una solicitud de préstamo aplicando criterios reales de la industria:
    relación deuda-ingreso (DTI) y score crediticio.
    Calcula el DTI resultante y decide: 'aprobado', 'derivar_a_humano' o 'fuera_de_parametros'.
    Requiere que el cliente haya sido identificado primero."""
    cliente = CLIENTES.get(dni.strip())
    if not cliente:
        return {"error": "Cliente no encontrado. Identificá al cliente primero."}

    cuota_mensual = monto_solicitado / PLAZO_MESES
    deuda_total_mensual = cliente["deuda_mensual"] + cuota_mensual
    dti = deuda_total_mensual / cliente["ingreso_mensual"]
    dti_pct = round(dti * 100, 1)
    score = cliente["credit_score"]

    if dti <= 0.36 and score >= 670:
        decision = "aprobado"
        motivo = f"DTI resultante {dti_pct}% (≤36%) y score {score} (≥670). Dentro de parámetros de aprobación automática."
    elif dti > 0.50 or score < 580:
        decision = "fuera_de_parametros"
        motivo = f"DTI resultante {dti_pct}% o score {score} fuera de los límites aceptables. Requiere intervención humana."
    else:
        decision = "derivar_a_humano"
        motivo = f"DTI resultante {dti_pct}% (zona 36-50%) o score {score} (zona 580-670). Requiere revisión de un analista."

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
  técnica como 'DTI' con el cliente; explicalo en palabras simples (ej: "por tu nivel de deuda
  actual en relación a tus ingresos").
- Nunca inventes datos del cliente: usá siempre las herramientas."""

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
