"""
Salud industry tools — MEMORY MOCK.

These tools back the kit's second industry vertical with an in-process
dict instead of a real CRM. Purpose: prove the multi-industry pattern
(manifest + loader + agent + voice) end-to-end without standing up a
second AWS deployment.

KNOWN LIMITATIONS — accepted for v1, documented in the README and the
decision log:
- All state (`_PACIENTES`, `_TURNOS`) lives in module globals and is
  lost when the agent process restarts. `agendar_turno` appends to
  `_TURNOS` and the next restart wipes those appointments.
- No concurrency control: two simultaneous calls writing to `_TURNOS`
  would race. Single-user demo assumption, same as banking's
  DEMO_THREAD_ID.
- No availability logic: `agendar_turno` confirms `fecha_preferida`
  verbatim. A real implementation would check calendar conflicts.

Privacy patterns inherited from banking iter-3 (DNI mismatch must not
reveal the real owner) are enforced by prompt.txt; the tools themselves
only return data for the DNI they were called with.
"""
from strands import tool


# Seeded patients. Three records cover the demo arc:
#   - Ana: active chronic condition + medication allergy
#   - Bruno: a single chronic condition
#   - Carla: clean history (control case)
_PACIENTES = {
    "30111222": {
        "dni": "30111222",
        "nombre": "Ana Pereyra",
        "edad": 58,
        "condiciones": ["hipertensión arterial"],
        "alergias": ["penicilina"],
        "ultima_visita": "2026-03-12",
    },
    "25333444": {
        "dni": "25333444",
        "nombre": "Bruno Otero",
        "edad": 64,
        "condiciones": ["diabetes tipo 2"],
        "alergias": [],
        "ultima_visita": "2026-05-02",
    },
    "28555666": {
        "dni": "28555666",
        "nombre": "Carla Méndez",
        "edad": 41,
        "condiciones": [],
        "alergias": [],
        "ultima_visita": "2026-01-20",
    },
}

# Appointments scheduled during this process lifetime. Cleared on restart.
_TURNOS: list[dict] = []


@tool
def identificar_paciente(dni: str) -> dict:
    """Valida la identidad de un paciente del centro médico por su número
    de DNI. Debe usarse SIEMPRE antes de consultar la historia clínica o
    agendar un turno."""
    dni = dni.strip()
    paciente = _PACIENTES.get(dni)
    if paciente is None:
        return {"identificado": False, "mensaje": "No encuentro un paciente con ese DNI."}
    return {"identificado": True, "dni": paciente["dni"], "nombre": paciente["nombre"]}


@tool
def consultar_historia(dni: str) -> dict:
    """Devuelve la historia clínica resumida de un paciente ya identificado:
    edad, condiciones crónicas, alergias y fecha de última visita."""
    dni = dni.strip()
    paciente = _PACIENTES.get(dni)
    if paciente is None:
        return {"error": "Paciente no encontrado. Identificá al paciente primero."}
    return {
        "nombre": paciente["nombre"],
        "edad": paciente["edad"],
        "condiciones": list(paciente["condiciones"]),
        "alergias": list(paciente["alergias"]),
        "ultima_visita": paciente["ultima_visita"],
    }


@tool
def agendar_turno(dni: str, especialidad: str, fecha_preferida: str) -> dict:
    """Agenda un turno para un paciente identificado en una especialidad y
    fecha solicitadas. Confirma la fecha pedida verbatim (mock — no
    chequea disponibilidad real). Devuelve un id de turno legible."""
    dni = dni.strip()
    paciente = _PACIENTES.get(dni)
    if paciente is None:
        return {"error": "Paciente no encontrado. Identificá al paciente primero."}

    turno_id = f"T-{len(_TURNOS) + 1000}"
    turno = {
        "turno_id": turno_id,
        "dni": dni,
        "especialidad": especialidad,
        "fecha_confirmada": fecha_preferida,
    }
    _TURNOS.append(turno)
    return {
        "agendado": True,
        "turno_id": turno_id,
        "especialidad": especialidad,
        "fecha_confirmada": fecha_preferida,
        "mensaje": f"Turno {turno_id} confirmado para {especialidad} el {fecha_preferida}.",
    }
