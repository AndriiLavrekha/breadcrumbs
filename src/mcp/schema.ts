import type { ALLOWED_SENSITIVITY, ALLOWED_STATUSES } from "../hook/schema.js";

export type ProjectStatus = (typeof ALLOWED_STATUSES)[number];

export type Sensitivity = (typeof ALLOWED_SENSITIVITY)[number];

export interface ProjectSummary {
  progressPath: string;
  project: string;
  status: ProjectStatus;
  path: string;
  updated: string;
  lastMilestone: string;
  deployed: boolean;
  deploymentUrl: string;
  sensitivity: Sensitivity;
  commitProgress: boolean;
  resumeSnapshot: string;
  nextAction: string;
  blockers: string;
  lastRuntime: string;
}
