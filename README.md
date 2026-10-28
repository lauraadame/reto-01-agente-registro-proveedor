# Agente de registro como proveedor

Agente conversacional local para preparar formularios, soportes y borradores a partir de los fixtures entregados. No firma, no accede a portales y no envía correos.

## Requisitos

Node.js 20+, npm y una clave de Groq solo para el chat con modelo.

## Arranque

```bash
npm install
copy .env.example .env
npm run dev
```

Abre `http://localhost:3000`. Configura `GROQ_API_KEY` en `.env` para conversar mediante Groq con `openai/gpt-oss-20b` por defecto. Sin clave, frontend y health funcionan, y el chat devuelve un mensaje recuperable. `FIXTURES_DIR` tiene por defecto `./reto-01` y no se modifica.

## Verificación

```bash
npm run demo
npm test
npm run lint
npm run typecheck
npm run build
```

`npm run demo` limpia `out/` y procesa los cuatro casos sin modelo.

## API

- `POST /api/chat` — `{ sessionId?, message }` → respuesta, trazas de herramientas y estado de confirmación.
- `GET /api/sessions/:id` — historial en memoria.
- `GET /api/health` — proveedor, modelo y disponibilidad de clave sin exponer secretos.

## Link de prueba

Pendiente de despliegue; prueba local en `http://localhost:3000`.
