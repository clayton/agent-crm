export const CRM_READ = "crm:read";
export const CRM_WRITE = "crm:write";
export const OFFLINE_ACCESS = "offline_access";

export const ALL_SCOPES = [CRM_READ, CRM_WRITE, OFFLINE_ACCESS] as const;

export type CrmScope = typeof CRM_READ | typeof CRM_WRITE;

export const READ_TOOLS = new Set([
  "crm_projects",
  "crm_get_company",
  "crm_list_companies",
  "crm_get_contact",
  "crm_list_contacts",
  "crm_get_prospect",
  "crm_list_prospects",
  "crm_list_interactions",
  "crm_inbox",
  "crm_next_actions",
  "crm_pipeline",
  "crm_forecast",
  "crm_conversions",
  "crm_cro_review",
  "crm_pipeline_risks",
  "crm_sdr_queue",
  "crm_experiment_report",
  "crm_research_brief",
  "crm_outreach_brief",
  "crm_search",
  "crm_timeline",
]);

export const WRITE_TOOLS = new Set([
  "crm_create_project",
  "crm_create_company",
  "crm_update_company",
  "crm_create_contact",
  "crm_update_contact",
  "crm_create_prospect",
  "crm_update_prospect",
  "crm_transition_prospect",
  "crm_qualify_opportunity",
  "crm_add_note",
  "crm_create_task",
  "crm_complete_task",
  "crm_log_interaction",
  "crm_bootstrap",
]);

export function scopesAllowTool(scopes: string[], toolName: string, args?: Record<string, unknown>): boolean {
  if (toolName === "crm_pipeline_risks" && args?.create_tasks) {
    return scopes.includes(CRM_WRITE);
  }
  if (WRITE_TOOLS.has(toolName)) return scopes.includes(CRM_WRITE);
  if (READ_TOOLS.has(toolName)) return scopes.includes(CRM_READ);
  return false;
}
