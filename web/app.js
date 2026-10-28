const form = document.querySelector('#composer');
const input = document.querySelector('#message');
const messages = document.querySelector('#messages');
const send = document.querySelector('#send');
const confirmation = document.querySelector('#confirmation');
const confirmationText = document.querySelector('#confirmation-text');
const confirmButton = document.querySelector('#confirm-button');
const connection = document.querySelector('#connection');
let sessionId;
let busy = false;
let pendingCase;

function entry(role, text, calls = []) {
  const article = document.createElement('article');
  article.className = `entry ${role}`;
  const heading = document.createElement('div');
  heading.className = 'entry-head';
  heading.textContent = role === 'user' ? 'TÚ' : 'ASISTENTE · REGISTRO';
  article.append(heading);
  for (const call of calls) {
    const details = document.createElement('details');
    details.className = 'trace';
    const summary = document.createElement('summary');
    summary.textContent = `Herramienta · ${call.name} — ${call.result}`;
    const detail = document.createElement('pre');
    detail.textContent = `Argumentos: ${JSON.stringify(call.arguments, null, 2)}\nResultado: ${call.result}`;
    details.append(summary, detail);
    article.append(details);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  article.append(bubble);
  messages.append(article);
  article.scrollIntoView({ block: 'end', behavior: 'smooth' });
  return article;
}

async function ask(value) {
  if (busy || !value.trim()) return;
  busy = true;
  send.disabled = true;
  confirmation.hidden = true;
  pendingCase = undefined;
  document.querySelector('.welcome')?.remove();
  entry('user', value);
  input.value = '';
  const thinking = entry('assistant', 'Consultando herramientas y preparando respuesta…');
  thinking.classList.add('thinking');
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, message: value }) });
    const data = await response.json();
    thinking.remove();
    if (!response.ok) throw new Error(data.error || 'No se pudo completar la solicitud');
    sessionId = data.sessionId;
    entry('assistant', data.reply, data.toolCalls || []);
    if (data.needsConfirmation && data.caseId) {
      pendingCase = data.caseId;
      confirmationText.textContent = `Caso ${data.caseId}. Solo se creará un registro local; no se enviará ningún correo.`;
      confirmation.hidden = false;
    }
  } catch (error) {
    thinking.remove();
    entry('assistant', `Error recuperable: ${error.message}. Puedes volver a intentar.`);
  } finally {
    busy = false;
    send.disabled = false;
    input.focus();
  }
}

form.addEventListener('submit', event => { event.preventDefault(); ask(input.value); });
input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
document.querySelectorAll('[data-case]').forEach(button => button.addEventListener('click', () => ask(`Procesa el caso ${button.dataset.case}. Dime qué campos faltan y cómo están los soportes. No envíes nada todavía.`)));
confirmButton.addEventListener('click', () => ask(`Confirmo. Simula el envío del caso ${pendingCase}.`));
document.querySelector('#new-session').addEventListener('click', () => { if (busy) return; sessionId = undefined; confirmation.hidden = true; messages.replaceChildren(); entry('assistant', 'Conversación nueva. Selecciona un caso o escribe tu solicitud.'); input.focus(); });
fetch('/api/health').then(response => response.json()).then(data => { connection.textContent = data.configured ? 'Agente conectado' : 'Sin clave · modo local disponible'; }).catch(() => { connection.textContent = 'Servidor no disponible'; });
