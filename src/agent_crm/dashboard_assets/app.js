(() => {
  "use strict";

  const app = document.getElementById("app");
  const dialog = document.getElementById("detail-dialog");
  const embedded = JSON.parse(document.getElementById("crm-data").textContent || "null");
  let data = embedded;
  let selected = "all";

  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const titleCase = (value) => String(value || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

  const shortDate = (value) => {
    if (!value) return "Not set";
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
  };

  const relativeDate = (value) => {
    if (!value) return "Never contacted";
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return value;
    const days = Math.round((date.valueOf() - Date.now()) / 86400000);
    if (days === 0) return "Today";
    if (days === -1) return "Yesterday";
    if (days === 1) return "Tomorrow";
    return days < 0 ? `${Math.abs(days)}d ago` : `in ${days}d`;
  };

  const money = (value, currency = "USD") => {
    if (value === null || value === undefined) return "—";
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
    } catch (_) {
      return `${value} ${currency}`;
    }
  };

  const visibleProjects = () => selected === "all"
    ? data.projects
    : data.projects.filter((item) => item.project.slug === selected);

  const allStages = (projects) => {
    const stages = new Map();
    projects.forEach((item) => item.pipeline.stages.forEach((stage) => {
      if (!stages.has(stage.key)) stages.set(stage.key, { ...stage, prospects: [], count: 0 });
      const target = stages.get(stage.key);
      stage.prospects.forEach((prospect) => target.prospects.push({ ...prospect, project_slug: item.project.slug, project_name: item.project.name }));
      target.count = target.prospects.length;
    }));
    return [...stages.values()].sort((a, b) => a.position - b.position);
  };

  const riskMap = (projects) => {
    const result = new Map();
    projects.forEach((item) => item.risks.forEach((risk) => {
      const list = result.get(risk.prospect_id) || [];
      list.push(risk);
      result.set(risk.prospect_id, list);
    }));
    return result;
  };

  const renderCard = (prospect, risks) => {
    const prospectRisks = risks.get(prospect.id) || [];
    const next = prospect.next_step || (prospect.next_contact_at ? `Follow up ${relativeDate(prospect.next_contact_at)}` : "No next step scheduled");
    return `
      <button class="prospect-card" type="button" data-prospect="${escapeHtml(prospect.id)}" data-project="${escapeHtml(prospect.project_slug)}">
        ${selected === "all" ? `<div class="card-project">${escapeHtml(prospect.project_name)}</div>` : ""}
        <div class="card-title">${escapeHtml(prospect.company_name || prospect.name)}</div>
        <div class="card-person">${escapeHtml(prospect.contact_name || prospect.name)}</div>
        <div class="card-meta">
          <span class="chip ${escapeHtml(prospect.priority)}">${escapeHtml(titleCase(prospect.priority))}</span>
          ${prospect.fit_score !== null && prospect.fit_score !== undefined ? `<span class="chip fit">Fit ${escapeHtml(prospect.fit_score)}</span>` : ""}
          ${prospect.amount !== null && prospect.amount !== undefined ? `<span class="chip money">${escapeHtml(money(prospect.amount, prospect.currency))}</span>` : ""}
          ${prospectRisks.length ? `<span class="chip risk">${prospectRisks.length} risk${prospectRisks.length === 1 ? "" : "s"}</span>` : ""}
        </div>
        <div class="card-next">${escapeHtml(next)}</div>
      </button>`;
  };

  const render = () => {
    const projects = visibleProjects();
    const stages = allStages(projects);
    const risks = riskMap(projects);
    const actions = projects.flatMap((item) => item.actions.map((action) => ({ ...action, project_name: item.project.name })))
      .sort((a, b) => b.score - a.score).slice(0, 8);
    const allRisks = projects.flatMap((item) => item.risks);
    const prospects = stages.reduce((total, stage) => total + stage.count, 0);
    const openPipeline = projects.reduce((total, item) => total + (item.forecast.open_pipeline || 0), 0);
    const weighted = projects.reduce((total, item) => total + (item.forecast.weighted_forecast || 0), 0);
    const currency = projects[0]?.forecast.currency || "USD";
    const riskCounts = allRisks.reduce((counts, risk) => {
      counts[risk.severity] = (counts[risk.severity] || 0) + 1;
      return counts;
    }, {});
    const currentName = selected === "all" ? "All pipelines" : projects[0]?.project.name || "Pipeline";
    const currentDescription = selected === "all"
      ? `${projects.length} agent-managed projects in one read-only view.`
      : projects[0]?.project.description || "A live view of agent-managed pipeline state.";

    app.innerHTML = `
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">A</div>
          <div><div class="brand-name">Agent CRM</div><div class="brand-meta">Human visibility · agent operated</div></div>
        </div>
        <select id="project-picker" class="project-picker" aria-label="Select project">
          <option value="all" ${selected === "all" ? "selected" : ""}>All projects</option>
          ${data.projects.map((item) => `<option value="${escapeHtml(item.project.slug)}" ${selected === item.project.slug ? "selected" : ""}>${escapeHtml(item.project.name)}</option>`).join("")}
        </select>
      </header>
      <main class="page"><div class="page-inner">
        <div class="heading-row">
          <div><p class="eyebrow">Pipeline overview</p><h1>${escapeHtml(currentName)}</h1><p class="subtitle">${escapeHtml(currentDescription)}</p></div>
          <span class="readonly-pill">Read only</span>
        </div>
        <section class="metrics" aria-label="Pipeline metrics">
          <div class="metric"><div class="metric-label">Active prospects</div><div class="metric-value">${prospects}</div><div class="metric-note">Across ${stages.filter((stage) => stage.count).length} populated stages</div></div>
          <div class="metric"><div class="metric-label">Needs attention</div><div class="metric-value">${allRisks.length}</div><div class="metric-note">Risks surfaced by the action engine</div></div>
          <div class="metric"><div class="metric-label">Open pipeline</div><div class="metric-value">${escapeHtml(money(openPipeline, currency))}</div><div class="metric-note">Qualified opportunity value</div></div>
          <div class="metric"><div class="metric-label">Weighted forecast</div><div class="metric-value">${escapeHtml(money(weighted, currency))}</div><div class="metric-note">Probability-adjusted value</div></div>
        </section>
        <section class="attention-grid">
          <div class="panel">
            <div class="panel-head"><h2>What needs attention</h2><span class="panel-count">Top ${actions.length}</span></div>
            <div class="action-list">${actions.length ? actions.map((action) => `
              <div class="action">
                <div class="action-score">${escapeHtml(action.score)}</div>
                <div><div class="action-title">${escapeHtml(action.suggested_action || action.title)}</div><div class="action-reason">${escapeHtml(action.why_now?.join(" · ") || action.reason || "")}</div></div>
                <div class="action-project">${escapeHtml(action.project_name)}</div>
              </div>`).join("") : '<div class="action"><div></div><div class="action-reason">Nothing urgent is currently surfaced.</div></div>'}</div>
          </div>
          <div class="panel">
            <div class="panel-head"><h2>Risk temperature</h2><span class="panel-count">${allRisks.length} total</span></div>
            <div class="risk-summary">${["critical", "high", "medium", "low"].map((level) => `<div class="risk-stat ${level}"><div class="risk-stat-value">${riskCounts[level] || 0}</div><div class="risk-stat-label">${level}</div></div>`).join("")}</div>
          </div>
        </section>
        <section>
          <div class="section-head"><h2>Pipeline</h2><div class="section-note">Select a card for its complete record · refreshed ${escapeHtml(shortDate(data.generated_at))}</div></div>
          <div class="board">${stages.map((stage) => `
            <div class="column">
              <div class="column-head"><span class="column-name">${escapeHtml(stage.name)}</span><span class="column-count">${stage.count}</span></div>
              <div class="column-cards">${stage.prospects.length ? stage.prospects.map((prospect) => renderCard(prospect, risks)).join("") : '<div class="empty-column">No prospects here</div>'}</div>
            </div>`).join("")}</div>
        </section>
      </div></main>`;

    document.getElementById("project-picker").addEventListener("change", (event) => {
      selected = event.target.value;
      render();
    });
    document.querySelectorAll("[data-prospect]").forEach((card) => card.addEventListener("click", () => showDetail(card.dataset.project, card.dataset.prospect)));
  };

  const showDetail = (projectSlug, prospectId) => {
    const project = data.projects.find((item) => item.project.slug === projectSlug);
    const detail = project?.prospect_details?.[prospectId];
    if (!detail) return;
    const risks = project.risks.filter((risk) => risk.prospect_id === prospectId);
    const facts = [
      ["Stage", detail.stage_name || titleCase(detail.stage)],
      ["Owner", detail.owner || "Unassigned"],
      ["Priority", titleCase(detail.priority)],
      ["Fit score", detail.fit_score ?? "Not scored"],
      ["Last contact", relativeDate(detail.last_contacted_at)],
      ["Next contact", shortDate(detail.next_contact_at)],
      ["Opportunity", detail.amount !== null && detail.amount !== undefined ? money(detail.amount, detail.currency) : "Not qualified"],
      ["Close date", shortDate(detail.expected_close_at)],
      ["Next step", detail.next_step || "Not set"],
    ];
    const list = (items, body, meta) => items.length
      ? items.map((item) => `<div class="detail-item">${escapeHtml(body(item))}<div class="detail-item-meta">${escapeHtml(meta(item))}</div></div>`).join("")
      : '<div class="empty-detail">None recorded.</div>';
    dialog.innerHTML = `<div class="detail-wrap">
      <button class="detail-close" type="button" aria-label="Close">×</button>
      <div class="detail-kicker">${escapeHtml(project.project.name)} · ${escapeHtml(detail.stage_name || detail.stage)}</div>
      <h2 class="detail-title">${escapeHtml(detail.company_name || detail.name)}</h2>
      <p class="detail-subtitle">${escapeHtml(detail.contact_name || detail.name)}${detail.contact_title ? ` · ${escapeHtml(detail.contact_title)}` : ""}</p>
      <div class="detail-grid">${facts.map(([label, value]) => `<div class="detail-fact"><div class="detail-label">${escapeHtml(label)}</div><div class="detail-value">${escapeHtml(value)}</div></div>`).join("")}</div>
      ${risks.length ? `<section class="detail-section"><h3>Risks</h3>${list(risks, (item) => item.message, (item) => `${titleCase(item.severity)} · ${item.recommended_action}`)}</section>` : ""}
      <section class="detail-section"><h3>Open tasks</h3>${list(detail.open_tasks || [], (item) => item.title, (item) => `${titleCase(item.priority)} · due ${shortDate(item.due_at)}`)}</section>
      <section class="detail-section"><h3>Notes</h3>${list(detail.notes || [], (item) => item.body, (item) => `${titleCase(item.kind)} · ${shortDate(item.created_at)}`)}</section>
      <section class="detail-section"><h3>Interactions</h3>${list(detail.interactions || [], (item) => item.summary, (item) => `${titleCase(item.channel)} · ${titleCase(item.direction)} · ${shortDate(item.occurred_at)}`)}</section>
      <section class="detail-section"><h3>Activity</h3>${list(detail.timeline || [], (item) => titleCase(item.action), (item) => `${item.actor} · ${shortDate(item.occurred_at)}`)}</section>
    </div>`;
    dialog.querySelector(".detail-close").addEventListener("click", () => dialog.close());
    dialog.showModal();
  };

  const start = async () => {
    try {
      if (!data) {
        const response = await fetch("/api/dashboard");
        if (!response.ok) throw new Error(`Dashboard request failed (${response.status})`);
        data = await response.json();
      }
      if (!data.projects.length) {
        app.innerHTML = '<div class="error-state">No CRM projects yet. Ask an agent to create one first.</div>';
        return;
      }
      render();
    } catch (error) {
      app.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`;
    }
  };

  start();
})();
