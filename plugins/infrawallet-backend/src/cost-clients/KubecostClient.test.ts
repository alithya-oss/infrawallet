import fc from 'fast-check';
import { Config } from '@backstage/config';

// Mock the consts module to break circular dependency (consts imports all clients)
jest.mock('../service/consts', () => ({
  CLOUD_PROVIDER: {
    AWS: 'AWS',
    GCP: 'GCP',
    AZURE: 'Azure',
    MONGODB_ATLAS: 'MongoAtlas',
    CONFLUENT: 'Confluent',
    DATADOG: 'Datadog',
    ELASTIC_CLOUD: 'ElasticCloud',
    GITHUB: 'GitHub',
    KUBECOST: 'Kubecost',
    CUSTOM: 'Custom',
    MOCK: 'Mock',
  },
  GRANULARITY: {
    DAILY: 'daily',
    MONTHLY: 'monthly',
  },
  PROVIDER_TYPE: {
    INTEGRATION: 'Integration',
    CUSTOM: 'Custom',
  },
  COST_CLIENT_MAPPINGS: {},
  METRIC_PROVIDER_MAPPINGS: {},
  CACHE_CATEGORY: {
    COSTS: 'costs',
    TAGS: 'tags',
    METRICS: 'metrics',
    CATEGORY_MAPPINGS: 'category_mappings',
  },
  DEFAULT_CATEGORY_MAPPING_CACHE_TTL: 12 * 60 * 60 * 1000,
  DEFAULT_TAGS_CACHE_TTL: {},
  DEFAULT_COSTS_CACHE_TTL: {},
  NUMBER_OF_MONTHS_FETCHING_HISTORICAL_COSTS: {},
}));

// Mock CategoryMappingService singleton
jest.mock('../service/CategoryMappingService', () => ({
  CategoryMappingService: {
    getInstance: () => ({
      getCategoryByServiceName: (_provider: string, serviceName: string) =>
        `category-${serviceName}`,
    }),
    initInstance: jest.fn(),
  },
}));

// Mock database/controller modules to avoid side effects
jest.mock('../controllers/MetricSettingController', () => ({
  getWallet: jest.fn(),
}));
jest.mock('../models/CostItem', () => ({
  bulkInsertCostItems: jest.fn(),
  countCostItems: jest.fn(),
  getCostItems: jest.fn(),
  CostItem: {},
}));
jest.mock('../service/functions', () => ({
  getDefaultCacheTTL: jest.fn().mockReturnValue(7200000),
  getReportsFromCache: jest.fn().mockResolvedValue(undefined),
  getTagKeysFromCache: jest.fn().mockResolvedValue(undefined),
  getTagValuesFromCache: jest.fn().mockResolvedValue(undefined),
  logTransformationSummary: jest.fn(),
  setReportsToCache: jest.fn(),
  setTagKeysToCache: jest.fn(),
  setTagValuesToCache: jest.fn(),
  tagExists: jest.fn().mockReturnValue(false),
  usageDateToPeriodString: jest.fn(),
}));

import { KubecostClient } from './KubecostClient';
import { CostQuery, Report } from '../service/types';

// ─── Test Helpers ────────────────────────────────────────────────────────────

/**
 * Creates a testable KubecostClient instance by exposing protected methods.
 */
class TestableKubecostClient extends KubecostClient {
  public async callTransformCostsData(
    subAccountConfig: Config,
    query: CostQuery,
    costResponse: any,
  ): Promise<Report[]> {
    return this.transformCostsData(subAccountConfig, query, costResponse);
  }

  public async callFetchCosts(
    subAccountConfig: Config,
    client: any,
    query: CostQuery,
  ): Promise<any> {
    return this.fetchCosts(subAccountConfig, client, query);
  }
}

/** Creates a mock Config object with the given values */
function createMockConfig(values: {
  name: string;
  baseUrl?: string;
  aggregate?: string;
  tags?: string[];
  filters?: Array<{ type: string; attribute: string; pattern: string }>;
}): Config {
  const filterConfigs = (values.filters || []).map(f => ({
    getString: (key: string) => {
      if (key === 'type') return f.type;
      if (key === 'attribute') return f.attribute;
      if (key === 'pattern') return f.pattern;
      throw new Error(`Unknown key: ${key}`);
    },
  }));

  return {
    getString: (key: string) => {
      if (key === 'name') return values.name;
      if (key === 'baseUrl') return values.baseUrl || 'http://localhost:9090';
      throw new Error(`Unknown key: ${key}`);
    },
    getOptionalString: (key: string) => {
      if (key === 'aggregate') return values.aggregate;
      return undefined;
    },
    getOptionalStringArray: (key: string) => {
      if (key === 'tags') return values.tags;
      return undefined;
    },
    getOptionalConfigArray: (key: string) => {
      if (key === 'filters') return filterConfigs.length > 0 ? filterConfigs : undefined;
      return undefined;
    },
  } as unknown as Config;
}

/** Creates a mock CostQuery */
function createMockQuery(
  granularity: 'daily' | 'monthly',
  startTime?: string,
  endTime?: string,
): CostQuery {
  return {
    filters: '',
    tags: '',
    groups: '',
    granularity: granularity as any,
    startTime: startTime || '1704067200000', // 2024-01-01
    endTime: endTime || '1706745600000', // 2024-02-01
  };
}

/** Creates a testable client instance */
function createTestClient(): TestableKubecostClient {
  const mockConfig = {
    getOptionalConfigArray: () => undefined,
    getOptionalString: () => undefined,
  } as unknown as Config;

  const mockDatabase = {} as any;
  const mockCache = { get: jest.fn(), set: jest.fn() } as any;
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as any;

  return new (TestableKubecostClient as any)(
    'Kubecost',
    mockConfig,
    mockDatabase,
    mockCache,
    mockLogger,
  ) as TestableKubecostClient;
}

// ─── Arbitrary Generators ────────────────────────────────────────────────────

/** Generates a valid allocation item name (non-empty alphanumeric with hyphens) */
const arbAllocationName = fc.stringMatching(/^[a-z][a-z0-9-]{0,30}$/);

/** Generates a valid instance name */
const arbInstanceName = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/);

/** Generates a positive cost value */
const arbPositiveCost = fc.double({ min: 0.01, max: 100000, noNaN: true });

/** Generates a non-positive cost value (zero or negative) */
const arbNonPositiveCost = fc.oneof(
  fc.constant(0),
  fc.double({ min: -100000, max: -0.01, noNaN: true }),
);

/** Generates a valid ISO timestamp string */
const arbTimestamp = fc
  .date({
    min: new Date('2020-01-01T00:00:00Z'),
    max: new Date('2025-12-31T23:59:59Z'),
  })
  .map(d => d.toISOString());

/** Generates a valid allocation item with a given totalCost */
function arbAllocationItem(totalCost: fc.Arbitrary<number>) {
  return fc.record({
    name: arbAllocationName,
    properties: fc.constant({}),
    cpuCost: fc.double({ min: 0, max: 1000, noNaN: true }),
    gpuCost: fc.double({ min: 0, max: 1000, noNaN: true }),
    ramCost: fc.double({ min: 0, max: 1000, noNaN: true }),
    pvCost: fc.double({ min: 0, max: 1000, noNaN: true }),
    networkCost: fc.double({ min: 0, max: 1000, noNaN: true }),
    sharedCost: fc.double({ min: 0, max: 1000, noNaN: true }),
    loadBalancerCost: fc.double({ min: 0, max: 1000, noNaN: true }),
    totalCost,
    start: arbTimestamp,
    end: arbTimestamp,
  });
}

/** Generates tag strings in "key:value" format */
const arbTag = fc
  .tuple(
    fc.stringMatching(/^[a-z]{1,10}$/),
    fc.stringMatching(/^[a-z0-9]{1,10}$/),
  )
  .map(([k, v]) => `${k}:${v}`);

/** Generates a list of tags */
const arbTags = fc.array(arbTag, { minLength: 0, maxLength: 5 });

// ─── Utility Functions ───────────────────────────────────────────────────────

/** Escapes special regex characters in a string */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Property-Based Tests ────────────────────────────────────────────────────

describe('KubecostClient Property-Based Tests', () => {
  let client: TestableKubecostClient;

  beforeEach(() => {
    client = createTestClient();
  });

  // ─── Property 1: Transformation produces valid reports with correct fields ───

  describe('Property 1: Transformation produces valid reports with correct fields', () => {
    it('should produce reports with correct provider, account, service, category, tags, and cost', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbAllocationItem(arbPositiveCost),
          arbInstanceName,
          arbTags,
          async (item, instanceName, tags) => {
            const config = createMockConfig({
              name: instanceName,
              tags: tags.length > 0 ? tags : undefined,
            });
            const query = createMockQuery('monthly');

            const costResponse = {
              code: 200,
              status: 'success',
              data: [{ [item.name]: item }],
            };

            const reports = await client.callTransformCostsData(config, query, costResponse);

            // Should produce at least one report for a positive-cost item
            expect(reports.length).toBeGreaterThanOrEqual(1);

            const report = reports[0];

            // Provider is 'Kubecost'
            expect(report.provider).toBe('Kubecost');

            // Account is 'Kubecost/{instanceName}'
            expect(report.account).toBe(`Kubecost/${instanceName}`);

            // Service is 'Kubecost/{allocationName}'
            expect(report.service).toBe(`Kubecost/${item.name}`);

            // Category is populated (via mocked CategoryMappingService)
            expect(report.category).toBe(`category-${item.name}`);

            // Provider type is INTEGRATION
            expect((report as any).providerType).toBe('Integration');

            // All configured tags are present (last value wins for duplicate keys)
            const expectedTags: Record<string, string> = {};
            for (const tag of tags) {
              const [k, v] = tag.split(':');
              if (k && v) {
                expectedTags[k.trim()] = v.trim();
              }
            }
            for (const [k, v] of Object.entries(expectedTags)) {
              expect((report as any)[k]).toBe(v);
            }

            // Cost amount equals totalCost
            const totalReportCost = Object.values(report.reports).reduce(
              (sum, c) => sum + c,
              0,
            );
            expect(totalReportCost).toBeCloseTo(item.totalCost, 5);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ─── Property 2: Zero and negative costs are excluded ──────────────────────

  describe('Property 2: Zero and negative costs are excluded', () => {
    it('should exclude allocation items with zero or negative totalCost', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.tuple(arbAllocationName, fc.oneof(arbPositiveCost, arbNonPositiveCost)),
            { minLength: 1, maxLength: 10 },
          ),
          arbInstanceName,
          async (items, instanceName) => {
            const config = createMockConfig({ name: instanceName });
            const query = createMockQuery('monthly');

            const timeWindowMap: Record<string, any> = {};
            for (const [name, cost] of items) {
              timeWindowMap[name] = {
                name,
                properties: {},
                cpuCost: 0,
                gpuCost: 0,
                ramCost: 0,
                pvCost: 0,
                networkCost: 0,
                sharedCost: 0,
                loadBalancerCost: 0,
                totalCost: cost,
                start: '2024-01-15T00:00:00Z',
                end: '2024-02-01T00:00:00Z',
              };
            }

            const costResponse = {
              code: 200,
              status: 'success',
              data: [timeWindowMap],
            };

            const reports = await client.callTransformCostsData(config, query, costResponse);

            // Verify only positive-cost items appear in reports
            for (const report of reports) {
              const allocationName = report.service.replace('Kubecost/', '');
              const originalItem = items.find(([name]) => name === allocationName);
              expect(originalItem).toBeDefined();
              if (originalItem) {
                expect(originalItem[1]).toBeGreaterThan(0);
              }
            }

            // No report should have a service name from a non-positive cost item
            const nonPositiveNames = items
              .filter(([_, cost]) => cost <= 0)
              .map(([name]) => `Kubecost/${name}`);
            const reportServiceNames = reports.map(r => r.service);
            for (const name of nonPositiveNames) {
              expect(reportServiceNames).not.toContain(name);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ─── Property 3: Report period format matches query granularity ─────────────

  describe('Property 3: Report period format matches query granularity', () => {
    it('should produce YYYY-MM period keys for monthly granularity', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbAllocationItem(arbPositiveCost),
          arbInstanceName,
          async (item, instanceName) => {
            const config = createMockConfig({ name: instanceName });
            const query = createMockQuery('monthly');

            const costResponse = {
              code: 200,
              status: 'success',
              data: [{ [item.name]: item }],
            };

            const reports = await client.callTransformCostsData(config, query, costResponse);

            for (const report of reports) {
              for (const periodKey of Object.keys(report.reports)) {
                expect(periodKey).toMatch(/^\d{4}-\d{2}$/);
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should produce YYYY-MM-DD period keys for daily granularity', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbAllocationItem(arbPositiveCost),
          arbInstanceName,
          async (item, instanceName) => {
            const config = createMockConfig({ name: instanceName });
            const query = createMockQuery('daily');

            const costResponse = {
              code: 200,
              status: 'success',
              data: [{ [item.name]: item }],
            };

            const reports = await client.callTransformCostsData(config, query, costResponse);

            for (const report of reports) {
              for (const periodKey of Object.keys(report.reports)) {
                expect(periodKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ─── Property 4: Filter correctness ────────────────────────────────────────

  describe('Property 4: Filter correctness', () => {
    it('should exclude items matching exclude filter patterns', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(arbAllocationName, { minLength: 2, maxLength: 10 }),
          arbInstanceName,
          async (names, instanceName) => {
            // Pick the first name as the one to exclude
            const excludeName = names[0];
            const config = createMockConfig({
              name: instanceName,
              filters: [
                {
                  type: 'exclude',
                  attribute: 'name',
                  pattern: `^${escapeRegex(excludeName)}$`,
                },
              ],
            });
            const query = createMockQuery('monthly');

            const timeWindowMap: Record<string, any> = {};
            for (const name of names) {
              timeWindowMap[name] = {
                name,
                properties: {},
                cpuCost: 1,
                gpuCost: 0,
                ramCost: 1,
                pvCost: 0,
                networkCost: 0,
                sharedCost: 0,
                loadBalancerCost: 0,
                totalCost: 10,
                start: '2024-01-15T00:00:00Z',
                end: '2024-02-01T00:00:00Z',
              };
            }

            const costResponse = {
              code: 200,
              status: 'success',
              data: [timeWindowMap],
            };

            const reports = await client.callTransformCostsData(config, query, costResponse);
            const reportServiceNames = reports.map(r => r.service);

            // The excluded name should not appear
            expect(reportServiceNames).not.toContain(`Kubecost/${excludeName}`);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should only include items matching include filter patterns', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(arbAllocationName, { minLength: 2, maxLength: 10 }),
          arbInstanceName,
          async (names, instanceName) => {
            // Pick the first name as the one to include
            const includeName = names[0];
            const config = createMockConfig({
              name: instanceName,
              filters: [
                {
                  type: 'include',
                  attribute: 'name',
                  pattern: `^${escapeRegex(includeName)}$`,
                },
              ],
            });
            const query = createMockQuery('monthly');

            const timeWindowMap: Record<string, any> = {};
            for (const name of names) {
              timeWindowMap[name] = {
                name,
                properties: {},
                cpuCost: 1,
                gpuCost: 0,
                ramCost: 1,
                pvCost: 0,
                networkCost: 0,
                sharedCost: 0,
                loadBalancerCost: 0,
                totalCost: 10,
                start: '2024-01-15T00:00:00Z',
                end: '2024-02-01T00:00:00Z',
              };
            }

            const costResponse = {
              code: 200,
              status: 'success',
              data: [timeWindowMap],
            };

            const reports = await client.callTransformCostsData(config, query, costResponse);

            // Only the included name should appear
            for (const report of reports) {
              const allocationName = report.service.replace('Kubecost/', '');
              expect(allocationName).toBe(includeName);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ─── Property 5: Window parameter formatting ───────────────────────────────

  describe('Property 5: Window parameter formatting', () => {
    it('should construct a window parameter with two valid ISO 8601 date strings separated by a comma', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1577836800000, max: 1767225600000 }), // 2020-01-01 to 2025-12-31
          fc.integer({ min: 1577836800000, max: 1767225600000 }),
          async (startMs, endMs) => {
            // Ensure start < end
            const [start, end] =
              startMs < endMs ? [startMs, endMs] : [endMs, startMs];
            if (start === end) return; // skip degenerate case

            // Capture the URL that fetch would be called with
            let capturedUrl = '';
            const mockFetch = jest.fn().mockImplementation(async (url: string) => {
              capturedUrl = url;
              return {
                ok: true,
                json: async () => ({ code: 200, status: 'success', data: [] }),
              };
            });
            const originalFetch = global.fetch;
            global.fetch = mockFetch as any;

            try {
              const config = createMockConfig({
                name: 'test',
                baseUrl: 'http://localhost:9090',
              });
              const query = createMockQuery('monthly', start.toString(), end.toString());
              const httpClient = { baseUrl: 'http://localhost:9090', name: 'test' };

              await client.callFetchCosts(config, httpClient, query);

              // Extract the window parameter from the captured URL
              const urlObj = new URL(capturedUrl);
              const windowParam = urlObj.searchParams.get('window');
              expect(windowParam).toBeDefined();

              const parts = windowParam!.split(',');
              expect(parts).toHaveLength(2);

              // Both parts should be valid ISO 8601 date strings (YYYY-MM-DD format)
              const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;
              expect(parts[0]).toMatch(isoDateRegex);
              expect(parts[1]).toMatch(isoDateRegex);

              // Both should parse to valid dates
              const startDate = new Date(parts[0]);
              const endDate = new Date(parts[1]);
              expect(startDate.getTime()).not.toBeNaN();
              expect(endDate.getTime()).not.toBeNaN();
            } finally {
              global.fetch = originalFetch;
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
