# Cinco decisiones

## 1. La política es código determinista, fuera del modelo

**Decisión.** `policy.ts` intercepta cada llamada que propone el modelo y decide si se ejecuta, se bloquea o queda pendiente, con reglas leídas de `agents.json` y `mock_tools.json`. El modelo no participa en esa decisión.

**Alternativa descartada.** Poner las reglas en el system prompt ("no muestres datos de otros agentes") o usar un segundo LLM como juez.

**Por qué.** Un prompt se puede persuadir, y la nota de José es justo ese intento. Una regla en código da la misma respuesta siempre, se puede probar con un eval y se explica en una línea de la traza.

## 2. El actor sale de la sesión; el modelo solo puede *expresar* a quién se refiere

**Decisión.** El modelo nunca recibe ni envía `agent_id`. La política descarta cualquier parámetro de identidad e inyecta el actor desde la cookie. El parámetro `agent` existe solo para que el modelo diga "el usuario pidió datos de María", y así la política pueda negarlo de forma explícita.

**Alternativa descartada.** No exponer ningún parámetro de dueño y filtrar en silencio por el actor.

**Por qué.** Con el filtro silencioso, "Muéstrame las llamadas de María" devolvería las llamadas de Andres, una respuesta que parece correcta pero es falsa. Negar de forma explícita es honesto con el agente y deja en la traza que el modelo lo intentó y el software lo impidió.

## 3. Las escrituras son un `pending_action` que solo confirma una persona

**Decisión.** `schedule_meeting` y `create_task` devuelven un token pendiente. El modelo no ve el token ni tiene herramienta para confirmar. Solo el botón Confirmar llama a `/api/confirm`, que exige la misma sesión, un token pendiente y de un solo uso.

**Alternativa descartada.** Que el modelo pregunte "¿confirmas?" en el chat y ejecute cuando el usuario responda "sí".

**Por qué.** Un "sí" en texto es ambiguo y también puede venir de una inyección dentro de un registro. Un botón fuera del canal del modelo separa de forma física la intención (modelo) del consentimiento (humano). Además permite mostrar el conflicto de agenda antes de decidir.

## 4. Las tarjetas se construyen con el resultado del software, no con el texto del modelo

**Decisión.** Clientes, agenda, bloqueos, pendientes y borradores se muestran desde el resultado de la herramienta o de la política. El modelo solo escribe una respuesta corta.

**Alternativa descartada.** Que el modelo formatee los datos en markdown dentro de su respuesta.

**Por qué.** Si los datos pasan por el modelo, se pueden omitir, alucinar o manipular con una inyección. Con este diseño, lo que el agente ve como dato es exactamente lo que devolvió el software, y la UI lo inserta como texto, nunca como HTML.

## 5. Zona horaria IANA por agente y comparaciones en UTC

**Decisión.** Se agregó `tz` a `agents.json`. Los eventos se convierten a instantes UTC, se muestran en la zona del agente con su abreviatura, y los conflictos se comparan por instante.

**Alternativa descartada.** Usar los offsets de `calendar.json` tal cual o mostrar en la zona del servidor.

**Por qué.** `calendar.json` mezcla `-04:00` y `-05:00`. Los dos eventos dicen "10:00" pero están separados por una hora, y un offset fijo deja de ser válido cuando termina el horario de verano (1 de noviembre de 2026). Con la zona IANA, la hora que ve el agente y la detección de conflictos son correctas en cualquier fecha.
