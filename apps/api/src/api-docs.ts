import { response } from './http';

const cdn = 'https://unpkg.com/swagger-ui-dist@5.34.1';
const init = 'SwaggerUIBundle({url:"/openapi.json",dom_id:"#swagger-ui",validatorUrl:null})';
const html = new TextEncoder().encode(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aviation Forecast Layers API</title>
<link rel="stylesheet" href="${cdn}/swagger-ui.css" integrity="sha384-4c3vsE5f+trhFyHrFrLM1fFGUn531NIaC7dcqEWIJdoRQJ5CkJbSuSCwXLpaS1KF" crossorigin="anonymous">
</head><body><h1>Aviation Forecast Layers API</h1><p><a href="/openapi.json">OpenAPI document</a></p>
<div id="swagger-ui"></div>
<script src="${cdn}/swagger-ui-bundle.js" integrity="sha384-XFYN47VzPiDY6qPtxYKg0nqUeW/upo20xf1j2SUE7gT/i35FJB4cuS/71Iegzk8Z" crossorigin="anonymous"></script>
<script>${init}</script></body></html>`);
const policy = [
  "default-src 'none'",
  "script-src https://unpkg.com 'sha256-8V7oQeldXISnTF4fYjeqaKlzHEh4sdOl8EJfsutWDHw='",
  'style-src https://unpkg.com',
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'"
].join('; ');

export function apiDocs(): Response {
  const page = response(html, 'text/html; charset=utf-8');
  page.headers.set('content-security-policy', policy);
  return page;
}
