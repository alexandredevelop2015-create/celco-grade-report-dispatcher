'use strict';

// Tudo é montado com textContent (nunca innerHTML): nomes e disciplinas vêm de entrada do usuário.
const $ = (sel) => document.querySelector(sel);
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === undefined || v === null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) el.append(c instanceof Node ? c : document.createTextNode(c ?? ''));
  return el;
}

let state = null;
let editing = null; // matrícula em edição; null = novo aluno
let busy = false;

const STATUS = {
  ENVIADO: ['Enviado', 'ok'],
  PENDENTE: ['Pendente de envio', ''],
  DESATUALIZADO: ['Alterado, não reenviado', 'warn'],
  FALHA: ['Falha no envio', 'bad'],
  QUARENTENA: ['Quarentena (dados conflitantes)', 'bad'],
  INVALIDO: ['Linha inválida', 'bad'],
};

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Erro ${res.status}`);
    err.issues = data.issues;
    throw err;
  }
  return data;
}

function toast(title, detail, kind) {
  const el = h('div', { class: `toast ${kind || ''}` }, title, ...(detail || []).map((d) => h('small', {}, d)));
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 12000 : 7000);
}

function setBusy(value) {
  busy = value;
  document.querySelectorAll('button').forEach((b) => (b.disabled = value));
}

/** Resultado de uma operação: o que aconteceu com o e-mail do aluno e com a auditoria. */
function reportResult(title, r) {
  const worst = r.audit.status === 'failed' || /FALHA|NÃO enviado/.test(r.studentNotice) ? 'bad' : r.audit.status === 'skipped' ? 'warn' : '';
  toast(title, [`Aluno: ${r.studentNotice}`, `Secretaria: ${r.audit.message}`], worst);
}

async function load() {
  try {
    state = await api('GET', '/api/state');
    render();
  } catch (e) {
    $('#meta').textContent = `Erro ao carregar: ${e.message}`;
  }
}

function render() {
  const s = state;
  $('#meta').textContent = `Período ${s.period} · ${s.file} · e-mail: ${s.notifier} · LLM: ${s.llm} · auditoria: ${s.auditEmail ? 'ligada' : 'desligada (defina ADMIN_EMAIL)'}`;

  const banner = $('#banner');
  const alerts = [];
  if (s.loadError) alerts.push(s.loadError);
  const bad = s.students.filter((x) => x.status === 'QUARENTENA' || x.status === 'INVALIDO').length;
  if (bad) alerts.push(`${bad} aluno(s) com dados conflitantes ou inválidos: nenhum boletim sai até corrigir (use Editar).`);
  if (s.notifier === 'console') alerts.push('Notificador "console": os e-mails só aparecem no terminal. Defina NOTIFIER=resend para enviar de verdade.');
  banner.hidden = alerts.length === 0;
  banner.className = `banner ${s.loadError ? 'bad' : ''}`;
  banner.textContent = alerts.join(' ');

  renderKpis();
  renderStudents();
  renderReport();
  renderChanges();
  renderEvents();
}

function renderKpis() {
  const r = state.report;
  const by = (st) => state.students.filter((x) => x.status === st).length;
  const kpis = [
    [state.students.length, 'alunos'],
    [by('ENVIADO'), 'boletins em dia'],
    [state.students.length - by('ENVIADO'), 'pendentes / com problema'],
    [r ? r.result.failed : '—', 'falhas na última execução'],
    [r ? `US$ ${r.costUsd.toFixed(4)}` : '—', 'custo estimado do LLM'],
    [r ? `${r.latencyMs.avgPerStudent} ms` : '—', 'tempo médio por aluno'],
  ];
  $('#kpis').replaceChildren(...kpis.map(([v, l]) => h('div', { class: 'kpi' }, h('b', {}, String(v)), h('span', {}, l))));
}

function renderStudents() {
  const q = $('#search').value.trim().toLowerCase();
  const list = state.students.filter((s) => !q || [s.name, s.studentId, s.email].some((v) => v.toLowerCase().includes(q)));
  const table = $('#students');
  if (!list.length) {
    table.replaceChildren(h('tbody', {}, h('tr', {}, h('td', { class: 'empty' }, state.students.length ? 'Nenhum aluno encontrado.' : 'Nenhum aluno ainda. Clique em "+ Novo aluno".'))));
    return;
  }
  table.replaceChildren(
    h('thead', {}, h('tr', {}, ...['Matrícula', 'Aluno', 'Notas', 'Média', 'Situação', ''].map((t) => h('th', {}, t)))),
    h(
      'tbody',
      {},
      list.map((s) => {
        const [label, kind] = STATUS[s.status] || [s.status, ''];
        return h(
          'tr',
          {},
          h('td', {}, s.studentId),
          h('td', {}, h('div', {}, s.name), h('div', { class: 'muted' }, s.email)),
          h('td', { class: 'grades' }, s.grades.map((g, i) => h('span', {}, i ? ' · ' : '', `${g.subject} `, h('span', { class: g.grade < state.passMark ? 'low' : '' }, String(g.grade))))),
          h('td', { class: 'num' }, `${s.average}/${state.scaleMax}`),
          h('td', {}, h('span', { class: `chip ${kind}`, title: s.error || '' }, label)),
          h(
            'td',
            { class: 'row-actions' },
            h('button', { class: 'link', type: 'button', onclick: () => openForm(s) }, 'Editar'),
            h('button', { class: 'link', type: 'button', title: 'Reenviar o boletim mesmo sem mudanças', onclick: () => resend(s) }, 'Reenviar'),
            h('button', { class: 'link bad', type: 'button', onclick: () => confirmDelete(s) }, 'Excluir'),
          ),
        );
      }),
    ),
  );
}

function renderReport() {
  const r = state.report;
  const box = $('#tab-report');
  if (!r) return box.replaceChildren(h('p', { class: 'empty' }, 'Nenhuma execução registrada ainda. Use "Executar envio" ou salve um aluno.'));
  const f = (n) => new Date(n).toLocaleString('pt-BR');
  const cards = [
    h('div', { class: 'card' }, h('h2', {}, `Execução ${r.runId}`), h('p', { class: 'muted' }, `${f(r.startedAt)} · ${r.durationMs} ms · trace ${r.traceId} · modelo ${r.model}`),
      h('ul', {},
        h('li', {}, `Entrada: ${r.input.totalRows} linhas, ${r.input.students} alunos válidos, ${r.input.rejectedRows} rejeitadas, ${r.input.duplicatesIgnored} duplicadas, ${r.input.quarantinedStudents} em quarentena`),
        h('li', {}, `Enviados: ${r.result.sent} (${r.result.updatedResent} atualizados, ${r.result.removed} removidos) · falhas: ${r.result.failed} · já enviados antes: ${r.result.skippedAlreadySent}`),
        h('li', {}, `Resumos: ${r.result.llmGenerated} LLM · ${r.result.cacheHits} cache · ${r.result.fallbackUsed} fallback determinístico`),
        h('li', {}, `Tokens: ${r.tokens.input} entrada + ${r.tokens.output} saída = ${r.tokens.total} · custo US$ ${r.costUsd.toFixed(6)}`),
        h('li', {}, `Tempo por aluno: média ${r.latencyMs.avgPerStudent} ms · p50 ${r.latencyMs.p50} ms · p95 ${r.latencyMs.p95} ms · ${r.throughputPerSec} alunos/s`),
      ),
    ),
  ];
  if (r.failures.length) cards.push(h('div', { class: 'card' }, h('h2', {}, 'Falhas'), h('ul', {}, r.failures.map((x) => h('li', {}, `${x.studentId} [${x.kind}] ${x.message}`)))));
  if (r.degraded.length) cards.push(h('div', { class: 'card' }, h('h2', {}, 'Degradação (fallback usado)'), h('ul', {}, r.degraded.map((x) => h('li', {}, `${x.reason}: ${x.count}`)))));
  if (r.rejected.length) cards.push(h('div', { class: 'card' }, h('h2', {}, 'Linhas rejeitadas'), h('ul', {}, r.rejected.map((x) => h('li', {}, `linha ${x.line}: ${x.reason}${x.field ? ` (${x.field})` : ''}`)))));
  box.replaceChildren(...cards);
}

function simpleTable(cols, rows) {
  return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))), h('tbody', {}, rows.map((cells) => h('tr', {}, cells.map((c) => h('td', {}, c)))))));
}

function renderChanges() {
  const rows = state.changes;
  const box = $('#tab-changes');
  if (!rows.length) return box.replaceChildren(h('p', { class: 'empty' }, 'Sem alterações registradas.'));
  const cols = Object.keys(rows[0]);
  box.replaceChildren(simpleTable(cols.map((c) => c.replaceAll('_', ' ')), rows.map((r) => cols.map((c) => r[c] ?? ''))));
}

function renderEvents() {
  const rows = state.events;
  const box = $('#tab-events');
  if (!rows.length) return box.replaceChildren(h('p', { class: 'empty' }, 'Sem eventos.'));
  box.replaceChildren(
    simpleTable(
      ['Quando', 'Evento', 'Detalhe'],
      rows.map(({ ts, name, runId, ...rest }) => [new Date(ts).toLocaleString('pt-BR'), name, Object.entries(rest).map(([k, v]) => k + '=' + v).join(' · ')]),
    ),
  );
}

// ---------- formulário de aluno ----------
function gradeRow(subject = '', grade = '') {
  const row = h('div', { class: 'grade-row' },
    h('input', { name: 'subject', placeholder: 'Disciplina', maxlength: '80', value: subject, 'aria-label': 'Disciplina' }),
    h('input', { name: 'grade', placeholder: 'Nota', inputmode: 'decimal', value: String(grade), 'aria-label': 'Nota' }),
    h('button', { type: 'button', title: 'Remover disciplina', onclick: () => row.remove() }, '×'),
  );
  return row;
}

function openForm(student) {
  editing = student ? student.studentId : null;
  const f = $('#form-student');
  $('#dlg-title').textContent = student ? `Editar ${student.name}` : 'Novo aluno';
  $('#scale').textContent = `(0 a ${state.scaleMax}; aprovado a partir de ${state.passMark})`;
  f.studentId.value = student?.studentId ?? '';
  f.studentId.readOnly = Boolean(student);
  f.name.value = student?.name ?? '';
  f.email.value = student?.email ?? '';
  f.notify.checked = true;
  $('#form-errors').textContent = '';
  $('#grade-rows').replaceChildren(...(student ? student.grades : [{}]).map((g) => gradeRow(g.subject, g.grade)));
  $('#dlg-student').showModal();
}

function readForm() {
  const f = $('#form-student');
  const grades = [...document.querySelectorAll('#grade-rows .grade-row')]
    .map((row) => ({ subject: row.children[0].value.trim(), raw: row.children[1].value.trim().replace(',', '.') }))
    .filter((g) => g.subject || g.raw)
    .map((g) => ({ subject: g.subject, grade: g.raw === '' ? NaN : Number(g.raw) }));
  return { studentId: f.studentId.value.trim(), name: f.name.value, email: f.email.value, grades, notify: f.notify.checked };
}

async function saveStudent(ev) {
  ev.preventDefault();
  const body = readForm();
  const bad = body.grades.find((g) => Number.isNaN(g.grade));
  const errors = $('#form-errors');
  if (bad) return void (errors.textContent = `Nota inválida em "${bad.subject}".`);
  setBusy(true);
  errors.textContent = '';
  try {
    const r = editing ? await api('PUT', `/api/students/${encodeURIComponent(editing)}`, body) : await api('POST', '/api/students', body);
    $('#dlg-student').close();
    reportResult(editing ? 'Aluno atualizado' : 'Aluno incluído', r);
    await load();
  } catch (e) {
    errors.textContent = [e.message, ...(e.issues || [])].join('\n');
  } finally {
    setBusy(false);
  }
}

// ---------- exclusão e execução ----------
function confirmDelete(student) {
  $('#confirm-title').textContent = `Excluir ${student.name}?`;
  $('#confirm-text').textContent = `Remove ${student.grades.length} nota(s) da matrícula ${student.studentId}. Se o aluno já recebeu boletim, ele é avisado de que o lançamento foi anulado.`;
  $('#confirm-notify').checked = true;
  $('#form-confirm').onsubmit = async (ev) => {
    ev.preventDefault();
    setBusy(true);
    try {
      const r = await api('DELETE', `/api/students/${encodeURIComponent(student.studentId)}`, { notify: $('#confirm-notify').checked });
      $('#dlg-confirm').close();
      reportResult('Aluno excluído', r);
      await load();
    } catch (e) {
      toast('Não foi possível excluir', [e.message], 'bad');
    } finally {
      setBusy(false);
    }
  };
  $('#dlg-confirm').showModal();
}

async function runDispatch(resendIds) {
  setBusy(true);
  try {
    reportResult('Execução concluída', await api('POST', '/api/dispatch', { resend: resendIds }));
    await load();
  } catch (e) {
    toast('Falha na execução', [e.message], 'bad');
  } finally {
    setBusy(false);
  }
}

const resend = (s) => runDispatch([s.studentId]);

// ---------- eventos ----------
$('#btn-new').onclick = () => openForm(null);
$('#btn-dispatch').onclick = () => runDispatch([]);
$('#btn-refresh').onclick = load;
$('#btn-add-grade').onclick = () => $('#grade-rows').append(gradeRow());
$('#btn-cancel').onclick = () => $('#dlg-student').close();
$('#confirm-cancel').onclick = () => $('#dlg-confirm').close();
$('#form-student').onsubmit = saveStudent;
$('#search').oninput = () => state && renderStudents();
document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    for (const id of ['students', 'report', 'changes', 'events']) $(`#tab-${id}`).hidden = id !== b.dataset.tab;
  }),
);

load();
setInterval(() => !busy && !document.querySelector('dialog[open]') && load(), 15000);
