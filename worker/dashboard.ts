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
    const risksResult = await service.pipelineRisks(db, slug);
    const risks = risksResult.risks;
    const actions = (
      await service.nextActions(db, slug, null, 5, null, "balanced", null, risks as Record<string, unknown>[])
    ).actions;
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
