// Toolsmith dashboard. No build step, no dependencies. Every value from the
// API is inserted with textContent (never innerHTML): tool names and
// descriptions come from third-party specs and must not be able to inject markup.

const I18N = {
  en: {
    skip: 'Skip to content',
    logout: 'Sign out',
    lang: 'العربية',
    'nav.overview': 'Overview',
    'nav.approvals': 'Approvals',
    'nav.integrations': 'Integrations',
    'nav.tools': 'Tools',
    'nav.workflows': 'Workflows',
    'nav.capabilities': 'Capability requests',
    'nav.traces': 'Traces',
    'nav.benchmarks': 'Benchmarks',
    'nav.audit': 'Audit log',
    'login.title': 'Sign in',
    'login.help':
      'Paste the admin token (TOOLSMITH_ADMIN_TOKEN in your .env). `toolsmith-mcp start` prints a link that signs you in directly.',
    'login.token': 'Admin token',
    'login.submit': 'Sign in',
    'login.bad': 'That token was not accepted.',
    tools: 'Tools exposed',
    awaiting: 'Awaiting approval',
    pendingCalls: 'Destructive calls waiting',
    calls24: 'Calls (24h)',
    errors24: 'Errors (24h)',
    api24: 'API requests (24h)',
    upstreams: 'Upstream MCP servers',
    problems: 'Problems',
    none: 'Nothing here yet.',
    name: 'Name',
    kind: 'Kind',
    status: 'Status',
    version: 'Version',
    published: 'Published',
    origin: 'Origin',
    evaluation: 'Evaluation',
    actions: 'Actions',
    approve: 'Approve & publish',
    reject: 'Reject',
    disable: 'Disable',
    enable: 'Enable',
    rollback: 'Roll back',
    evaluate: 'Re-run evaluation',
    allowWrite: 'Expose write tools',
    allowDestructive: 'Expose destructive tools (each call still needs approval)',
    passed: 'passed',
    failed: 'failed',
    back: '← Back',
    history: 'History',
    plan: 'Plan',
    inputSchema: 'Input schema',
    operations: 'Operations',
    findings: 'Spec findings',
    permissions: 'Permissions',
    readOnly: 'read-only',
    tool: 'Tool',
    access: 'Access',
    source: 'Source',
    description: 'Description',
    workflow: 'Workflow',
    sessions: 'Sessions',
    confidence: 'Confidence',
    callsPerRun: 'MCP calls / run',
    span: 'Agent time / run',
    propose: 'Propose composite tools from these',
    noPatterns:
      'No repeated workflows yet. They appear after agents repeat the same sequence of calls in several sessions.',
    ask: 'Check a request',
    askPlaceholder: "e.g. Find a customer's latest order and show its payment status",
    verdict: 'Verdict',
    request: 'Request',
    when: 'When',
    session: 'Session',
    duration: 'ms',
    ok: 'OK',
    api: 'API req.',
    filterTool: 'Filter by tool',
    refresh: 'Refresh',
    approveCall: 'Approve call',
    rejectCall: 'Reject call',
    args: 'Arguments',
    pendingVersions: 'Integrations and tools awaiting approval',
    pendingCallsTitle: 'Destructive calls awaiting approval',
    noBench: 'No benchmark results yet. Run `npm run benchmark` in the repository.',
    actor: 'Actor',
    action: 'Action',
    target: 'Target',
    inputJson: 'Test input (JSON, optional)',
    done: 'Done',
    steps: 'Steps',
  },
  ar: {
    skip: 'تخطَّ إلى المحتوى',
    logout: 'تسجيل الخروج',
    lang: 'English',
    'nav.overview': 'نظرة عامة',
    'nav.approvals': 'الموافقات',
    'nav.integrations': 'التكاملات',
    'nav.tools': 'الأدوات',
    'nav.workflows': 'سير العمل',
    'nav.capabilities': 'طلبات القدرات',
    'nav.traces': 'السجلات',
    'nav.benchmarks': 'قياس الأداء',
    'nav.audit': 'سجل التدقيق',
    'login.title': 'تسجيل الدخول',
    'login.help':
      'الصق رمز المشرف (TOOLSMITH_ADMIN_TOKEN في ملف ‎.env). يطبع الأمر `toolsmith-mcp start` رابطًا يسجّل دخولك مباشرة.',
    'login.token': 'رمز المشرف',
    'login.submit': 'دخول',
    'login.bad': 'لم يُقبل هذا الرمز.',
    tools: 'الأدوات المتاحة',
    awaiting: 'بانتظار الموافقة',
    pendingCalls: 'استدعاءات حذف بانتظار الموافقة',
    calls24: 'الاستدعاءات (٢٤ ساعة)',
    errors24: 'الأخطاء (٢٤ ساعة)',
    api24: 'طلبات API (٢٤ ساعة)',
    upstreams: 'خوادم MCP المتصلة',
    problems: 'مشكلات',
    none: 'لا شيء هنا بعد.',
    name: 'الاسم',
    kind: 'النوع',
    status: 'الحالة',
    version: 'الإصدار',
    published: 'المنشور',
    origin: 'المصدر',
    evaluation: 'التقييم',
    actions: 'إجراءات',
    approve: 'موافقة ونشر',
    reject: 'رفض',
    disable: 'تعطيل',
    enable: 'تفعيل',
    rollback: 'تراجع',
    evaluate: 'إعادة التقييم',
    allowWrite: 'إتاحة أدوات الكتابة',
    allowDestructive: 'إتاحة أدوات الحذف (كل استدعاء يحتاج موافقة)',
    passed: 'ناجح',
    failed: 'فاشل',
    back: '→ رجوع',
    history: 'السجل',
    plan: 'الخطة',
    inputSchema: 'مخطط المدخلات',
    operations: 'العمليات',
    findings: 'ملاحظات المواصفة',
    permissions: 'الصلاحيات',
    readOnly: 'قراءة فقط',
    tool: 'الأداة',
    access: 'الوصول',
    source: 'المصدر',
    description: 'الوصف',
    workflow: 'سير العمل',
    sessions: 'الجلسات',
    confidence: 'الثقة',
    callsPerRun: 'استدعاءات MCP لكل تشغيل',
    span: 'وقت الوكيل لكل تشغيل',
    propose: 'اقترح أدوات مركّبة منها',
    noPatterns:
      'لا يوجد سير عمل متكرر بعد. يظهر عندما يكرر الوكلاء نفس تسلسل الاستدعاءات في عدة جلسات.',
    ask: 'افحص طلبًا',
    askPlaceholder: 'مثال: اعرض آخر طلب للعميل وحالة الدفع',
    verdict: 'النتيجة',
    request: 'الطلب',
    when: 'الوقت',
    session: 'الجلسة',
    duration: 'مللي ثانية',
    ok: 'ناجح',
    api: 'طلبات API',
    filterTool: 'تصفية حسب الأداة',
    refresh: 'تحديث',
    approveCall: 'وافق على الاستدعاء',
    rejectCall: 'ارفض الاستدعاء',
    args: 'المعاملات',
    pendingVersions: 'تكاملات وأدوات بانتظار الموافقة',
    pendingCallsTitle: 'استدعاءات حذف بانتظار الموافقة',
    noBench: 'لا توجد نتائج قياس بعد. شغّل `npm run benchmark` في المستودع.',
    actor: 'المنفّذ',
    action: 'الإجراء',
    target: 'الهدف',
    inputJson: 'مدخل اختبار (JSON، اختياري)',
    done: 'تم',
    steps: 'الخطوات',
  },
};

let lang = safeGet('ts-lang') || 'en';
let token = safeGet('ts-token', sessionStorage) || '';
const t = (k) => I18N[lang][k] ?? I18N.en[k] ?? k;

function safeGet(k, store = localStorage) {
  try {
    return store.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k, v, store = localStorage) {
  try {
    if (v === null) store.removeItem(k);
    else store.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
}

/** Tiny DOM builder. Strings become text nodes, never HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const statusClass = (s) =>
  ['published', 'approved', 'connected'].includes(s)
    ? 'ok'
    : ['failed', 'rejected', 'disabled'].includes(s)
      ? 'bad'
      : ['awaiting_approval', 'proposed', 'testing', 'generating', 'pending'].includes(s)
        ? 'warn'
        : '';
const pill = (s, cls = statusClass(s)) => h('span', { class: `pill ${cls}` }, s);

async function api(path, opts = {}) {
  const res = await fetch(`/api/${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error(t('login.bad'));
  }
  const data = await res.json().catch(() => null);
  if (!res.ok)
    throw new Error(`${data?.error ?? res.statusText}${data?.hint ? ` — ${data.hint}` : ''}`);
  return data;
}

function toast(msg, isError = false) {
  const box = h('div', { class: isError ? 'error' : '' }, msg);
  document.getElementById('toast').append(box);
  setTimeout(() => box.remove(), 6000);
}

function table(cols, rows, empty = t('none')) {
  if (!rows.length) return h('p', { class: 'muted' }, empty);
  return h(
    'div',
    { class: 'panel' },
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          cols.map((c) => h('th', { scope: 'col' }, c)),
        ),
      ),
      h(
        'tbody',
        {},
        rows.map((r) =>
          h(
            'tr',
            {},
            r.map((cell) => h('td', {}, cell)),
          ),
        ),
      ),
    ),
  );
}

const fmtMs = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);
// Units next to numbers must not be reordered in right-to-left layouts.
const ms = (n) => h('bdi', {}, fmtMs(n));
const code = (v) => h('pre', {}, typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function evalView(ev) {
  if (!ev) return h('span', { class: 'muted' }, '—');
  return h(
    'div',
    {},
    pill(ev.passed ? t('passed') : t('failed'), ev.passed ? 'ok' : 'bad'),
    h(
      'ul',
      { class: 'checks' },
      ev.checks.map((c) =>
        h(
          'li',
          {},
          h(
            'span',
            { 'aria-hidden': 'true' },
            c.passed ? (c.severity === 'warning' ? '⚠ ' : '✓ ') : '✗ ',
          ),
          h('strong', {}, c.name),
          c.detail ? h('span', { class: 'muted' }, ` — ${c.detail}`) : null,
        ),
      ),
    ),
  );
}

// ---- Views -----------------------------------------------------------------

const views = {
  async overview() {
    const o = await api('overview');
    document.getElementById('version').textContent = `v${o.version}`;
    return [
      h('h1', {}, t('nav.overview')),
      h(
        'div',
        { class: 'grid' },
        [
          [t('tools'), o.tools],
          [t('awaiting'), o.awaitingApproval],
          [t('pendingCalls'), o.pendingCallApprovals],
          [t('calls24'), o.last24h.calls],
          [t('errors24'), o.last24h.errors],
          [t('api24'), o.last24h.upstreamRequests],
        ].map(([k, v]) =>
          h(
            'div',
            { class: 'card' },
            h('div', { class: 'muted' }, k),
            h('div', { class: 'stat' }, v),
          ),
        ),
      ),
      h('h2', {}, t('upstreams')),
      table(
        [t('name'), 'transport', t('status'), t('tools')],
        o.upstreams.map((u) => [
          u.name,
          u.transport,
          pill(u.connected ? 'connected' : (u.error ?? 'down'), u.connected ? 'ok' : 'bad'),
          u.toolCount,
        ]),
      ),
      h('h2', {}, t('problems')),
      table(
        [t('name'), t('description')],
        o.problems.map((p) => [p.artifact, p.problem]),
      ),
    ];
  },

  async approvals() {
    const [arts, calls] = await Promise.all([
      api('artifacts'),
      api('call-approvals?status=pending'),
    ]);
    const waiting = arts.filter((a) => a.latestStatus === 'awaiting_approval');
    return [
      h('h1', {}, t('nav.approvals')),
      h('h2', {}, t('pendingVersions')),
      table(
        [t('name'), t('kind'), t('version'), t('origin'), ''],
        waiting.map((a) => [
          h('a', { href: `#artifact/${encodeURIComponent(a.name)}` }, a.name),
          a.kind,
          `v${a.latestVersion}`,
          a.origin,
          h('a', { href: `#artifact/${encodeURIComponent(a.name)}` }, t('evaluation') + ' →'),
        ]),
      ),
      h('h2', {}, t('pendingCallsTitle')),
      table(
        ['id', t('tool'), t('args'), t('when'), t('actions')],
        calls.map((c) => [
          h('code', {}, c.id),
          c.tool,
          code(c.args),
          c.createdAt,
          h(
            'div',
            { class: 'row' },
            h(
              'button',
              { onclick: () => act(`call-approvals/${c.id}`, { approve: true }) },
              t('approveCall'),
            ),
            h(
              'button',
              { class: 'danger', onclick: () => act(`call-approvals/${c.id}`, { approve: false }) },
              t('rejectCall'),
            ),
          ),
        ]),
      ),
    ];
  },

  async integrations() {
    const arts = await api('artifacts');
    return [
      h('h1', {}, t('nav.integrations')),
      table(
        [t('name'), t('kind'), t('version'), t('status'), t('published'), t('evaluation')],
        arts.map((a) => [
          h('a', { href: `#artifact/${encodeURIComponent(a.name)}` }, a.name),
          a.kind,
          a.latestVersion ? `v${a.latestVersion}` : '—',
          pill(a.latestStatus ?? '—'),
          a.publishedVersion ? `v${a.publishedVersion}` : '—',
          a.evaluationPassed === null
            ? '—'
            : pill(
                a.evaluationPassed ? t('passed') : t('failed'),
                a.evaluationPassed ? 'ok' : 'bad',
              ),
        ]),
      ),
    ];
  },

  async artifact(name) {
    const d = await api(`artifacts/${encodeURIComponent(name)}`);
    const latest = d.versions[0];
    const def = latest.definition;
    const out = [
      h('p', {}, h('a', { href: '#integrations' }, t('back'))),
      h('h1', {}, d.artifact.name, ' ', pill(latest.status)),
    ];
    out.push(
      h(
        'p',
        { class: 'muted' },
        `${d.artifact.kind} · v${latest.version} · ${t('origin')}: ${latest.origin}`,
      ),
    );
    const ref = `artifacts/${encodeURIComponent(name)}`;
    if (latest.status === 'awaiting_approval') {
      const w = h('input', { type: 'checkbox', id: 'allow-w' });
      const dd = h('input', { type: 'checkbox', id: 'allow-d' });
      out.push(
        h(
          'div',
          { class: 'card' },
          def.kind === 'openapi'
            ? h(
                'div',
                {},
                h('label', {}, w, ' ', t('allowWrite')),
                h('br'),
                h('label', {}, dd, ' ', t('allowDestructive')),
              )
            : null,
          h(
            'div',
            { class: 'row' },
            h(
              'button',
              {
                onclick: () =>
                  act(`${ref}/approve`, {
                    version: latest.version,
                    allowWrite: w.checked,
                    allowDestructive: dd.checked,
                  }),
              },
              t('approve'),
            ),
            h(
              'button',
              { class: 'danger', onclick: () => act(`${ref}/reject`, { version: latest.version }) },
              t('reject'),
            ),
          ),
        ),
      );
    }
    const input = h('textarea', { 'aria-label': t('inputJson'), placeholder: '{"userId": 1}' });
    out.push(
      h(
        'div',
        { class: 'row' },
        d.artifact.publishedVersion
          ? h('button', { class: 'ghost', onclick: () => act(`${ref}/disable`, {}) }, t('disable'))
          : null,
        d.versions.some((v) => v.status === 'disabled') && !d.artifact.publishedVersion
          ? h('button', { class: 'ghost', onclick: () => act(`${ref}/enable`, {}) }, t('enable'))
          : null,
        d.versions.some((v) => v.status === 'approved')
          ? h(
              'button',
              { class: 'ghost', onclick: () => act(`${ref}/rollback`, {}) },
              t('rollback'),
            )
          : null,
      ),
    );
    if (d.artifact.kind !== 'upstream') {
      out.push(
        h(
          'details',
          {},
          h('summary', {}, t('evaluate')),
          h('label', {}, t('inputJson')),
          input,
          h(
            'button',
            {
              onclick: () => {
                let parsed;
                try {
                  parsed = input.value.trim() ? JSON.parse(input.value) : undefined;
                } catch {
                  return toast('Invalid JSON', true);
                }
                act(`${ref}/evaluate`, parsed ? { input: parsed } : {});
              },
            },
            t('evaluate'),
          ),
        ),
      );
    }
    out.push(h('h2', {}, t('evaluation')), evalView(latest.evaluation));
    out.push(
      h('h2', {}, t('permissions')),
      h(
        'p',
        {},
        [
          latest.permissions.allowWrite && 'write',
          latest.permissions.allowDestructive && 'destructive',
        ]
          .filter(Boolean)
          .join(', ') || t('readOnly'),
      ),
    );
    if (def.kind === 'openapi') {
      out.push(
        h('h2', {}, t('operations')),
        table(
          [t('tool'), 'method', 'path', t('access'), t('description')],
          def.operations.map((o) => [
            h('code', {}, `${d.artifact.name}__${o.name}`),
            o.method,
            h('code', {}, o.path),
            pill(o.access, o.access === 'read' ? 'ok' : o.access === 'write' ? 'warn' : 'bad'),
            o.summary || o.description,
          ]),
        ),
      );
      if (def.findings.length)
        out.push(
          h('h2', {}, t('findings')),
          table(
            ['', t('description')],
            def.findings.map((f) => [
              pill(
                f.severity,
                f.severity === 'error' ? 'bad' : f.severity === 'warning' ? 'warn' : '',
              ),
              f.message,
            ]),
          ),
        );
    } else if (def.kind === 'composite') {
      out.push(h('p', {}, h('code', {}, def.toolName), ' — ', def.description));
      out.push(
        h('h2', {}, t('plan')),
        code(def.steps),
        h('h2', {}, t('inputSchema')),
        code(def.inputSchema),
      );
    }
    out.push(
      h('h2', {}, t('history')),
      table(
        [t('when'), t('version'), t('status'), t('actor'), ''],
        d.events.map((e) => [
          e.at,
          `v${e.version}`,
          h('span', {}, e.fromStatus ?? '∅', ' → ', pill(e.toStatus)),
          e.actor,
          e.reason ?? '',
        ]),
      ),
    );
    return out;
  },

  async tools() {
    const tools = await api('tools');
    return [
      h('h1', {}, t('nav.tools')),
      table(
        [t('tool'), t('source'), t('access'), t('description')],
        tools.map((x) => [
          h('code', {}, x.name),
          x.source,
          pill(x.access, x.access === 'read' ? 'ok' : x.access === 'write' ? 'warn' : 'bad'),
          x.description,
        ]),
      ),
    ];
  },

  async workflows() {
    const patterns = await api('patterns');
    return [
      h('h1', {}, t('nav.workflows')),
      patterns.length
        ? h(
            'div',
            { class: 'row' },
            h('button', { onclick: () => act('patterns/propose', {}, '#approvals') }, t('propose')),
          )
        : null,
      table(
        [t('workflow'), t('sessions'), t('confidence'), t('callsPerRun'), t('span')],
        patterns.map((p) => [
          h('code', {}, p.signature),
          p.support,
          p.confidence,
          p.stats.medianMcpCalls,
          ms(p.stats.medianSpanMs),
        ]),
        t('noPatterns'),
      ),
    ];
  },

  async capabilities() {
    const list = await api('capabilities');
    const input = h('input', {
      type: 'text',
      placeholder: t('askPlaceholder'),
      'aria-label': t('request'),
    });
    const result = h('div');
    const form = h(
      'form',
      {
        class: 'row',
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const a = await api('capabilities', { method: 'POST', body: { request: input.value } });
            result.replaceChildren(
              h(
                'div',
                { class: 'card' },
                pill(
                  a.verdict,
                  a.verdict === 'available' ? 'ok' : a.verdict === 'unsupported' ? 'bad' : 'warn',
                ),
                ' ',
                a.explanation,
                a.chain
                  ? h(
                      'ol',
                      {},
                      a.chain.map((c) =>
                        h(
                          'li',
                          {},
                          h('code', {}, c.tool),
                          c.feeds ? h('span', { class: 'muted' }, ` ${c.feeds}`) : null,
                        ),
                      ),
                    )
                  : null,
              ),
            );
          } catch (err) {
            toast(err.message, true);
          }
        },
      },
      input,
      h('button', { type: 'submit' }, t('ask')),
    );
    return [
      h('h1', {}, t('nav.capabilities')),
      form,
      result,
      h('h2', {}, t('history')),
      table(
        [t('request'), t('verdict'), t('description')],
        list.map((a) => [
          a.request,
          pill(
            a.verdict,
            a.verdict === 'available' ? 'ok' : a.verdict === 'unsupported' ? 'bad' : 'warn',
          ),
          a.explanation,
        ]),
      ),
    ];
  },

  async traces() {
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const tool = params.get('tool') ?? '';
    const [rows, stats] = await Promise.all([
      api(`traces?limit=100${tool ? `&tool=${encodeURIComponent(tool)}` : ''}`),
      api('traces/stats'),
    ]);
    const filter = h('input', {
      type: 'text',
      value: tool,
      placeholder: t('filterTool'),
      'aria-label': t('filterTool'),
    });
    return [
      h('h1', {}, t('nav.traces')),
      h(
        'form',
        {
          class: 'row',
          onsubmit: (e) => {
            e.preventDefault();
            location.hash = `traces?tool=${encodeURIComponent(filter.value)}`;
          },
        },
        filter,
        h('button', { type: 'submit' }, t('refresh')),
      ),
      h('h2', {}, 'p50 / p95'),
      table(
        [t('tool'), 'calls', 'errors', 'p50', 'p95', t('api')],
        stats
          .slice(0, 20)
          .map((s) => [
            h('code', {}, s.tool),
            s.calls,
            s.errors,
            ms(s.p50),
            ms(s.p95),
            s.upstreamRequests,
          ]),
      ),
      h('h2', {}, t('nav.traces')),
      table(
        [t('when'), t('session'), t('tool'), t('duration'), t('ok'), t('api'), t('args')],
        rows.map((r) => [
          new Date(r.startedAt).toLocaleTimeString(lang),
          r.sessionId,
          h('code', {}, r.tool),
          Math.round(r.durationMs),
          r.ok ? pill('ok', 'ok') : pill(r.errorCode ?? 'error', 'bad'),
          r.upstreamRequests,
          r.args ? h('details', {}, h('summary', {}, '…'), code(r.args)) : '—',
        ]),
      ),
    ];
  },

  async benchmarks() {
    const b = await api('benchmarks');
    if (!b) return [h('h1', {}, t('nav.benchmarks')), h('p', { class: 'muted' }, t('noBench'))];
    const out = [
      h('h1', {}, t('nav.benchmarks')),
      h(
        'p',
        { class: 'muted' },
        `${b.generatedAt} · ${b.environment?.node ?? ''} · ${b.environment?.cpu ?? ''}`,
      ),
    ];
    for (const s of b.performance?.scenarios ?? []) {
      const max = Math.max(...s.variants.map((v) => v.latency.p95));
      out.push(
        h('h2', {}, s.name),
        h(
          'div',
          { class: 'card' },
          s.variants.map((v) =>
            h(
              'div',
              { class: 'barrow' },
              h('span', {}, v.name),
              h('div', {
                class: 'bar',
                style: `width:${Math.max(2, (v.latency.p50 / max) * 100)}%`,
              }),
              h(
                'span',
                {},
                `p50 ${fmtMs(v.latency.p50)} · p95 ${fmtMs(v.latency.p95)} · ${v.mcpCalls} MCP · ${v.apiRequests} API`,
              ),
            ),
          ),
        ),
      );
    }
    return out;
  },

  async audit() {
    const rows = await api('audit');
    return [
      h('h1', {}, t('nav.audit')),
      table(
        [t('when'), t('actor'), t('action'), t('target')],
        rows.map((r) => [r.at, r.actor, r.action, r.target ?? '']),
      ),
    ];
  },
};

async function act(path, body, then) {
  try {
    await api(path, { method: 'POST', body });
    toast(t('done'));
    if (then) location.hash = then;
    else await render();
  } catch (err) {
    toast(err.message, true);
  }
}

function showLogin() {
  document.getElementById('login').hidden = false;
  document.getElementById('view').replaceChildren();
}

async function render() {
  applyLang();
  if (!token) return showLogin();
  document.getElementById('login').hidden = true;
  const hash = location.hash.slice(1) || 'overview';
  const [route, arg] = hash.split('?')[0].split('/');
  for (const a of document.querySelectorAll('#nav a'))
    a.setAttribute(
      'aria-current',
      a.getAttribute('href') === `#${route === 'artifact' ? 'integrations' : route}`
        ? 'page'
        : 'false',
    );
  const view = document.getElementById('view');
  try {
    const fn = views[route] ?? views.overview;
    const content = await fn(arg ? decodeURIComponent(arg) : undefined);
    view.replaceChildren(...[content].flat().filter(Boolean));
    const o = await api('overview').catch(() => null);
    const n = o ? o.awaitingApproval + o.pendingCallApprovals : 0;
    const badge = document.getElementById('approvals-badge');
    badge.hidden = n === 0;
    badge.textContent = String(n);
  } catch (err) {
    view.replaceChildren(h('p', { class: 'error', role: 'alert' }, err.message));
  }
}

function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const badge = el.querySelector('.badge');
    el.textContent = t(el.dataset.i18n);
    if (badge) el.append(badge);
  }
  const btn = document.getElementById('lang');
  btn.textContent = t('lang');
  btn.setAttribute('aria-label', lang === 'ar' ? 'Switch to English' : 'التبديل إلى العربية');
}

// Token handed over in the URL fragment (never sent to the server) by `toolsmith-mcp start`.
// "#workflows&token=…&lang=ar" keeps the route and strips the secrets/options.
const m = location.hash.match(/(?:^#|&)token=([^&]+)/);
const l = location.hash.match(/(?:^#|&)lang=(en|ar)/);
if (l) {
  lang = l[1];
  safeSet('ts-lang', lang);
}
if (m) {
  token = decodeURIComponent(m[1]);
  safeSet('ts-token', token, sessionStorage);
}
if (m || l) {
  const route = location.hash
    .slice(1)
    .split('&')
    .filter((p) => !/^(token|lang)=/.test(p))
    .join('&');
  history.replaceState(null, '', `${location.pathname}#${route || 'overview'}`);
}

document.getElementById('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  token = document.getElementById('token').value.trim();
  safeSet('ts-token', token, sessionStorage);
  render().catch(() => {
    document.getElementById('login-error').textContent = t('login.bad');
  });
});
document.getElementById('logout').addEventListener('click', () => {
  token = '';
  safeSet('ts-token', null, sessionStorage);
  showLogin();
});
document.getElementById('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ar' : 'en';
  safeSet('ts-lang', lang);
  render();
});
window.addEventListener('hashchange', render);
render();
