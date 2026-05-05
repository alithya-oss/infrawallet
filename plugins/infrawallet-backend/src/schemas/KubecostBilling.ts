import { z } from 'zod';

export const KubecostAllocationItemSchema = z.object({
  name: z.string(),
  properties: z.record(z.string(), z.any()),
  cpuCost: z.number(),
  gpuCost: z.number(),
  ramCost: z.number(),
  pvCost: z.number(),
  networkCost: z.number(),
  sharedCost: z.number(),
  loadBalancerCost: z.number(),
  totalCost: z.number(),
  start: z.string(),
  end: z.string(),
});

export const KubecostAllocationResponseSchema = z.object({
  code: z.number(),
  status: z.string(),
  data: z.array(z.record(z.string(), KubecostAllocationItemSchema)),
});

export type KubecostAllocationItem = z.infer<typeof KubecostAllocationItemSchema>;
export type KubecostAllocationResponse = z.infer<typeof KubecostAllocationResponseSchema>;
