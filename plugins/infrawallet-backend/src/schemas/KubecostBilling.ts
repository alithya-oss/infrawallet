import { z } from 'zod';

export const KubecostAllocationItemSchema = z
  .object({
    name: z.string(),
    properties: z.record(z.string(), z.any()).optional(),
    cpuCost: z.number().optional().default(0),
    gpuCost: z.number().optional().default(0),
    ramCost: z.number().optional().default(0),
    pvCost: z.number().optional().default(0),
    networkCost: z.number().optional().default(0),
    sharedCost: z.number().optional().default(0),
    loadBalancerCost: z.number().optional().default(0),
    totalCost: z.number(),
    start: z.string(),
    end: z.string(),
  })
  .passthrough();

export const KubecostAllocationResponseSchema = z.object({
  code: z.number(),
  status: z.string().optional(),
  data: z.union([
    z.array(z.record(z.string(), KubecostAllocationItemSchema)),
    z.record(z.string(), KubecostAllocationItemSchema),
  ]),
});

export type KubecostAllocationItem = z.infer<typeof KubecostAllocationItemSchema>;
export type KubecostAllocationResponse = z.infer<typeof KubecostAllocationResponseSchema>;
