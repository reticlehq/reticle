import { FlowFileSchema, ReticleVerificationRunSchema } from '@reticlehq/core';
import { z } from 'zod';

const ProjectIdSchema = z.string().min(1).max(120);
const FlowNameSchema = z.string().min(1).max(160);

export const FlowUploadSchema = z.object({
  flow: FlowFileSchema.refine((flow) => flow.name.length <= 160, 'flow name is too long'),
  projectId: ProjectIdSchema.optional(),
});

export const VerificationRequestSchema = z.object({
  previewUrl: z.string().url(),
  flows: z.array(FlowNameSchema).min(1).max(50),
  source: z.string().min(1).max(120),
});
export type VerificationRequest = z.infer<typeof VerificationRequestSchema>;

export const ProjectRunUploadSchema = z.object({
  flowName: FlowNameSchema,
  status: z.string().min(1).max(40),
  kind: z.string().min(1).max(40),
  summary: z.string().max(2_000).optional(),
  at: z.number(),
  projectId: ProjectIdSchema.optional(),
});
export type ProjectRunUpload = z.infer<typeof ProjectRunUploadSchema>;

export const VerificationRunUploadSchema = ReticleVerificationRunSchema;

export const RunnerRequestSchema = VerificationRequestSchema.extend({
  verificationId: z.string().uuid(),
});
export type RunnerRequest = z.infer<typeof RunnerRequestSchema>;

export const RemoteFlowStatus = {
  PASS: 'pass',
  FAIL: 'fail',
  UNVERIFIED: 'unverified',
} as const;
export type RemoteFlowStatus = (typeof RemoteFlowStatus)[keyof typeof RemoteFlowStatus];

export interface RemoteFlowResult {
  name: string;
  status: RemoteFlowStatus;
  detail?: string;
}

export interface VerificationResponse {
  verificationId: string;
  verdict: RemoteFlowStatus;
  flows: RemoteFlowResult[];
  summary: string;
}
