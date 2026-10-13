import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUrl, queryTool, handle, tools } from '../server.mjs';

const ferramenta = (nome) => tools.find((t) => t.name === nome);
const json = (corpo, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });

test('catálogo tem 17 ferramentas, todas somente leitura e com schema válido', () => {
  assert.equal(tools.length, 17);
  assert.equal(new Set(tools.map((t) => t.name)).size, 17);
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.description.length > 10, t.name);
  }
});

test('monta a URL do PNCP com caminho e consulta', () => {
  assert.equal(buildUrl(ferramenta('pncp_itens'), { cnpj: '12345678000199', ano: 2026, sequencial: 7 }),
    'https://pncp.gov.br/api/pncp/v1/orgaos/12345678000199/compras/2026/7/itens?pagina=1&tamanhoPagina=10');
  assert.equal(buildUrl(ferramenta('pncp_propostas_abertas'), { dataFinal: '20261031', uf: 'SP', codigoModalidadeContratacao: 6 }),
    'https://pncp.gov.br/api/consulta/v1/contratacoes/proposta?dataFinal=20261031&codigoModalidadeContratacao=6&uf=SP&pagina=1&tamanhoPagina=10');
});

test('rejeita entradas inválidas antes de chamar a API', () => {
  const itens = ferramenta('pncp_itens');
  assert.throws(() => buildUrl(itens, { cnpj: '123', ano: 2026, sequencial: 1 }), /14 dígitos/);
  assert.throws(() => buildUrl(itens, { cnpj: '12345678000199', ano: 2026, sequencial: 1, inventado: 1 }), /desconhecido/);
  assert.throws(() => buildUrl(itens, { cnpj: '12345678000199', ano: '2026', sequencial: 1 }), /Tipo inválido/);
  const pub = ferramenta('pncp_publicacoes');
  assert.throws(() => buildUrl(pub, { dataInicial: '20260230', dataFinal: '20260301', codigoModalidadeContratacao: 6 }), /inexistente/);
  assert.throws(() => buildUrl(pub, { dataInicial: '20261010', dataFinal: '20261001', codigoModalidadeContratacao: 6 }), /posterior/);
  assert.throws(() => buildUrl(pub, { dataInicial: '2026-10-01', dataFinal: '20261010', codigoModalidadeContratacao: 6 }), /Formato/);
});

test('consulta devolve fonte, URL, data e preserva inteiros grandes', async () => {
  const r = await queryTool('pncp_modalidades', {}, async () =>
    new Response('[{"id":12345678901234567890,"nome":"Pregão - Eletrônico"}]', { headers: { 'content-type': 'application/json' } }));
  assert.equal(r.fonte, 'pncp');
  assert.match(r.url, /^https:\/\/pncp\.gov\.br\/api\/pncp\/v1\/modalidades/);
  assert.ok(Date.parse(r.consultadoEm));
  assert.equal(r.dados[0].nome, 'Pregão - Eletrônico');
  assert.equal(String(r.dados[0].id), '12345678901234567890');
});

test('erro HTTP não vira lista vazia', async () => {
  await assert.rejects(() => queryTool('pncp_modalidades', {}, async () => json({}, 500)), /HTTP 500.*não significa ausência/);
});

test('resposta acima de 1,5 MB é recusada', async () => {
  const grande = '[' + '"x",'.repeat(400_000) + '"x"]';
  await assert.rejects(() => queryTool('pncp_modalidades', {}, async () => new Response(grande, { headers: { 'content-type': 'application/json' } })), /1,5 MB/);
});

test('filtro de materiais ignora acentos e informa cobertura', async () => {
  const paginas = { 1: ['Reagente para hematologia', 'Seringa descartável'], 2: ['REAGENTE BIOQUÍMICA', 'Luva'] };
  const r = await queryTool('compras_filtrar_materiais', { termo: 'reagente', maxPaginas: 5 }, async (url) => {
    const p = Number(new URL(url).searchParams.get('pagina'));
    return json({ resultado: paginas[p].map((d) => ({ descricaoItem: d })), totalPaginas: 2 });
  });
  assert.equal(r.resultados.length, 2);
  assert.equal(r.registrosExaminados, 4);
  assert.equal(r.coberturaCompleta, true);
  assert.equal(r.proximaPagina, null);
});

test('filtro de materiais devolve parcial quando a API falha', async () => {
  const r = await queryTool('compras_filtrar_materiais', { termo: 'luva' }, async () => json({}, 503));
  assert.equal(r.coberturaCompleta, false);
  assert.equal(r.proximaPagina, 1);
  assert.match(r.erro, /HTTP 503/);
});

test('protocolo MCP: initialize, tools/list, notificação e método inexistente', async () => {
  const ini = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(ini.result.protocolVersion, '2025-06-18');
  assert.equal(ini.result.serverInfo.name, 'compras-publicas');
  assert.equal((await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.length, 17);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal((await handle({ jsonrpc: '2.0', id: 3, method: 'nada' })).error.code, -32601);
  const erro = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'pncp_itens', arguments: { cnpj: '1' } } });
  assert.equal(erro.result.isError, true);
});

test('servidor responde pela entrada padrão (stdio), como um cliente MCP faz', async () => {
  const servidor = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))]);
  let saida = '';
  servidor.stdout.on('data', (d) => { saida += d; });
  servidor.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
  servidor.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  servidor.stdin.write('isto não é json\n');
  servidor.stdin.end('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
  await new Promise((ok) => servidor.on('close', ok));
  const linhas = saida.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(linhas.length, 3);
  assert.equal(linhas[0].result.serverInfo.name, 'compras-publicas');
  assert.equal(linhas[1].error.code, -32700);
  assert.equal(linhas[2].result.tools.length, 17);
});

test('funciona chamado por link simbólico (npx / node_modules/.bin)', { skip: process.platform === 'win32' }, () => {
  const link = join(mkdtempSync(join(tmpdir(), 'mcp-')), 'compras-publicas-mcp');
  symlinkSync(fileURLToPath(new URL('../server.mjs', import.meta.url)), link);
  const saida = execFileSync(process.execPath, [link], { input: '{"jsonrpc":"2.0","id":1,"method":"ping"}\n' }).toString();
  assert.deepEqual(JSON.parse(saida), { jsonrpc: '2.0', id: 1, result: {} });
});
