import type { D1Database } from "@cloudflare/workers-types";
import * as service from "./service";

export async function dashboardData(
  db: D1Database,
  project?: string | null,
  includeTerminal = false,
): Promise<Record<string, unknown>> {
  const projects = await service.listProjects(db);
  let selectedProjects = projects;
  if (project) {
    const resolved = await service.resolveProject(db, project);
    selectedProjects = projects.filter((p) => p.id === resolved.id);
  }

  const results = [];
  for (const projectRow of selectedProjects) {
    const slug = String(projectRow.slug);
    const pipeline = await service.pipeline(db, slug, includeTerminal);
    const risks = (await service.pipelineRisks(db, slug)).risks;
    const actions = (await service.nextActions(db, slug)).actions;
    const prospectIds: string[] = [];
    for (const stage of pipeline.stages as Array<{ prospects: Array<{ id: string }> }>) {
      for (const prospect of stage.prospects) prospectIds.push(prospect.id);
    }
    const details: Record<string, unknown> = {};
    for (const prospectId of prospectIds) {
      const detail = await service.getProspect(db, prospectId);
      detail.timeline = await service.timeline(db, "prospect", prospectId, 50);
      details[prospectId] = detail;
    }
    results.push({
      project: {
        id: projectRow.id,
        slug,
        name: projectRow.name,
        description: projectRow.description,
        settings: projectRow.settings ?? {},
      },
      pipeline,
      actions,
      risks,
      forecast: await service.forecast(db, slug),
      prospect_details: details,
    });
  }
  return {
    generated_at: service.now(),
    read_only: true,
    includes_terminal_stages: includeTerminal,
    selected_project: project ?? null,
    projects: results,
  };
}

export async function dashboardJson(db: D1Database, project?: string | null, includeTerminal = false) {
  return dashboardData(db, project, includeTerminal);
}
