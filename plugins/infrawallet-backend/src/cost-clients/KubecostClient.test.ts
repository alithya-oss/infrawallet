/**
 * @file KubecostClient.test.ts
 * @description Transactional tests for the KubecostClient cost integration.
 *
 * This test suite validates the data transactions through the KubecostClient:
 * - Outbound requests: config + query → correct HTTP request to Kubecost API
 * - Error propagation: API failures → proper error handling
 * - Data transformation: Kubecost allocation responses → InfraWallet reports
 * - Filtering: include/exclude rules applied during transformation
 * - Data integrity: zero/negative costs excluded, internal allocations skipped
 *
 * @module KubecostClient.test
 */

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

jest.mock('../service/CategoryMappingService', () => ({
  CategoryMappingService: {
    getInstance: () => ({
      getCategoryByServiceName: (_provider: any, serviceName: any) => `category-${serviceName}`,
    }),
    initInstance: jest.fn(),
  },
}));

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
import { CostQuery } from '../service/types';

// ─── Test Helpers ────────────────────────────────────────────────────────────

type TestableClient = ReturnType<typeof createTestableClient>;

function createTestableClient(clientInstance: any) {
  return {
    callTransformCostsData: (subAccountConfig: Config, query: CostQuery, costResponse: any): Promise<any[]> =>
      clientInstance.transformCostsData(subAccountConfig, query, costResponse),
    callFetchCosts: (subAccountConfig: Config, client: any, query: CostQuery): Promise<any> =>
      clientInstance.fetchCosts(subAccountConfig, client, query),
  };
}

/**
 * Creates a mock Backstage Config object.
 *
 * @param {object} values - Configuration values to mock
 * @returns {Config} A mocked Config object
 */
function createMockConfig(values: {
  name: string;
  baseUrl?: string;
  apiVersion?: string;
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
      if (key === 'baseUrl') return values.baseUrl || 'https://kubecost.example.com';
      throw new Error(`Unknown key: ${key}`);
    },
    getOptionalString: (key: string) => {
      if (key === 'aggregate') return values.aggregate;
      if (key === 'apiVersion') return values.apiVersion;
      return undefined;
    },
    getOptionalNumber: (_key: string) => undefined,
    getOptionalStringArray: (key: string) => {
      if (key === 'tags') return values.tags;
      return undefined;
    },
    getOptionalConfigArray: (key: string) => {
      if (key === 'filters') return filterConfigs.length > 0 ? filterConfigs : undefined;
      return undefined;
    },
    has: (_key: string) => false,
    getConfig: (key: string) => {
      throw new Error(`Unknown config key: ${key}`);
    },
  } as unknown as Config;
}

function createMockQuery(granularity: 'daily' | 'monthly', startTime?: string, endTime?: string): CostQuery {
  return {
    filters: '',
    tags: '',
    groups: '',
    granularity: granularity as any,
    startTime: startTime || '1704067200000',
    endTime: endTime || '1706745600000',
  };
}

function createTestClient(): TestableClient {
  const mockConfig = {
    getOptionalConfigArray: () => undefined,
    getOptionalString: () => undefined,
  } as unknown as Config;

  const instance = KubecostClient.create(mockConfig, {} as any, { get: jest.fn(), set: jest.fn() } as any, {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as any);
  return createTestableClient(instance);
}

/** Creates a minimal allocation entry with a positive cost field */
function allocation(name: string, totalCost: number, start = '2024-01-15T00:00:00Z') {
  return { name, totalCost, cpuCost: totalCost, start, end: '2024-02-01T00:00:00Z', properties: {} };
}

/** Wraps allocation data into a standard Kubecost API response */
function wrapCostResponse(data: any) {
  return { code: 200, data: Array.isArray(data) ? data : [data] };
}

/** Escapes special regex characters */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Shared test constants ───────────────────────────────────────────────────

const TEST_BASE_URL = 'https://kubecost.example.com';
const defaultConfig = () => createMockConfig({ name: 'kc', baseUrl: TEST_BASE_URL });
const defaultHttpClient = (apiVersion: 'v1' | 'v2' | 'v3' = 'v1') => ({
  baseUrl: TEST_BASE_URL,
  name: 'kc',
  apiVersion,
});
const recentQuery = (granularity: 'daily' | 'monthly' = 'daily') => {
  const now = Date.now();
  return createMockQuery(granularity, (now - 3600000).toString(), now.toString());
};

// ─── Arbitrary Generators ────────────────────────────────────────────────────

const arbAllocationName = fc.stringMatching(/^[a-z][a-z0-9-]{0,30}$/);
const arbInstanceName = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/);
const arbPositiveCost = fc.double({ min: 0.01, max: 100000, noNaN: true });
const arbNonPositiveCost = fc.oneof(fc.constant(0), fc.double({ min: -100000, max: -0.01, noNaN: true }));
const arbTimestamp = fc
  .date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2025-12-31T23:59:59Z') })
  .map(d => d.toISOString());

function arbAllocationItem(totalCost: fc.Arbitrary<number>) {
  return fc
    .record({
      name: arbAllocationName,
      properties: fc.constant({}),
      gpuCost: fc.double({ min: 0, max: 1000, noNaN: true }),
      ramCost: fc.double({ min: 0, max: 1000, noNaN: true }),
      pvCost: fc.double({ min: 0, max: 1000, noNaN: true }),
      networkCost: fc.double({ min: 0, max: 1000, noNaN: true }),
      sharedCost: fc.double({ min: 0, max: 1000, noNaN: true }),
      loadBalancerCost: fc.double({ min: 0, max: 1000, noNaN: true }),
      totalCost,
      start: arbTimestamp,
      end: arbTimestamp,
    })
    .map(item => ({ ...item, cpuCost: item.totalCost }));
}

const arbTags = fc.array(
  fc.tuple(fc.stringMatching(/^[a-z]{1,10}$/), fc.stringMatching(/^[a-z0-9]{1,10}$/)).map(([k, v]) => `${k}:${v}`),
  { minLength: 0, maxLength: 5 },
);

// ─── Transaction Tests ───────────────────────────────────────────────────────

describe('KubecostClient Transactions', () => {
  let client: TestableClient;

  beforeEach(() => {
    client = createTestClient();
  });

  // ─── Outbound Request Construction ─────────────────────────────────────────

  describe('fetchCosts → HTTP request', () => {
    let originalFetch: typeof global.fetch;
    let capturedUrl: string;

    beforeEach(() => {
      capturedUrl = '';
      originalFetch = global.fetch;
      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        capturedUrl = url;
        return { ok: true, json: async () => ({ code: 200, data: [] }) };
      }) as any;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it.each([
      { apiVersion: 'v1' as const, granularity: 'monthly' as const, expectedAccumulate: 'accumulate=true' },
      { apiVersion: 'v1' as const, granularity: 'daily' as const, expectedAccumulate: 'accumulate=false' },
      { apiVersion: 'v2' as const, granularity: 'monthly' as const, expectedAccumulate: 'accumulate=month' },
      { apiVersion: 'v2' as const, granularity: 'daily' as const, expectedAccumulate: 'accumulate=day' },
      { apiVersion: 'v3' as const, granularity: 'monthly' as const, expectedAccumulate: 'accumulate=month' },
      { apiVersion: 'v3' as const, granularity: 'daily' as const, expectedAccumulate: 'accumulate=day' },
    ])(
      'should produce correct request for $apiVersion $granularity',
      async ({ apiVersion, granularity, expectedAccumulate }) => {
        await client.callFetchCosts(defaultConfig(), defaultHttpClient(apiVersion), recentQuery(granularity));

        expect(capturedUrl).toContain('/model/allocation?');
        expect(capturedUrl).toContain(expectedAccumulate);
        expect(capturedUrl).toContain('idle=false');
        expect(capturedUrl).toContain('aggregate=namespace');
      },
    );

    it('should propagate configured aggregate to the request', async () => {
      const config = createMockConfig({ name: 'kc', baseUrl: TEST_BASE_URL, aggregate: 'deployment' });

      await client.callFetchCosts(config, defaultHttpClient(), recentQuery());

      expect(capturedUrl).toContain('aggregate=deployment');
    });
  });

  // ─── Error Propagation ───────────────────────────────────────────────────────

  describe('fetchCosts → error propagation', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should propagate HTTP errors', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      }) as any;

      await expect(client.callFetchCosts(defaultConfig(), defaultHttpClient(), recentQuery())).rejects.toThrow(
        /HTTP 403/,
      );
    });

    it('should propagate API-level errors', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 500, status: 'error', data: null }),
      }) as any;

      await expect(client.callFetchCosts(defaultConfig(), defaultHttpClient(), recentQuery())).rejects.toThrow(
        /code 500/,
      );
    });

    it('should succeed when response has no error code', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      }) as any;

      await expect(client.callFetchCosts(defaultConfig(), defaultHttpClient(), recentQuery())).resolves.toBeDefined();
    });
  });

  // ─── Data Transformation ─────────────────────────────────────────────────────

  describe('transformCostsData → report generation', () => {
    const transformConfig = () => createMockConfig({ name: 'test' });
    const monthlyQuery = () => createMockQuery('monthly');

    it('should skip internal allocations (__idle__, __unallocated__)', async () => {
      const costResponse = wrapCostResponse({
        __idle__: allocation('__idle__', 100),
        __unallocated__: allocation('__unallocated__', 50),
        'my-app': allocation('my-app', 25),
      });

      const reports = await client.callTransformCostsData(transformConfig(), monthlyQuery(), costResponse);
      const services = reports.map(r => r.service);
      expect(services).not.toContain('Kubecost/__idle__');
      expect(services).not.toContain('Kubecost/__unallocated__');
      expect(services).toContain('Kubecost/my-app');
    });

    it('should aggregate costs across multiple time windows', async () => {
      const costResponse = {
        code: 200,
        data: [
          { ns1: allocation('ns1', 10, '2024-01-15T00:00:00Z') },
          { ns1: allocation('ns1', 20, '2024-02-15T00:00:00Z') },
        ],
      };

      const reports = await client.callTransformCostsData(transformConfig(), monthlyQuery(), costResponse);
      expect(reports.length).toBe(1);
      expect(reports[0].reports['2024-01']).toBe(10);
      expect(reports[0].reports['2024-02']).toBe(20);
    });

    it('should handle non-array data format', async () => {
      const costResponse = { code: 200, data: { ns1: allocation('ns1', 10) } };

      const reports = await client.callTransformCostsData(transformConfig(), monthlyQuery(), costResponse);
      expect(reports.length).toBe(1);
      expect(reports[0].reports['2024-01']).toBe(10);
    });

    it('should skip null entries and invalid timestamps', async () => {
      const costResponse = {
        code: 200,
        data: [
          null,
          {
            'bad-ts': allocation('bad-ts', 10, 'not-a-date'),
            'good-ts': allocation('good-ts', 10),
          },
        ],
      };

      const reports = await client.callTransformCostsData(transformConfig(), monthlyQuery(), costResponse);
      const services = reports.map(r => r.service);
      expect(services).not.toContain('Kubecost/bad-ts');
      expect(services).toContain('Kubecost/good-ts');
    });
  });
});

// ─── Property-Based Transaction Tests ────────────────────────────────────────

describe('KubecostClient Property-Based Transactions', () => {
  let client: TestableClient;

  beforeEach(() => {
    client = createTestClient();
  });

  describe('transform invariant: valid input → valid report structure', () => {
    it('should produce reports with correct provider, account, service, and tags', async () => {
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
            const costResponse = wrapCostResponse({ [item.name]: item });

            const reports = await client.callTransformCostsData(config, createMockQuery('monthly'), costResponse);

            expect(reports.length).toBeGreaterThanOrEqual(1);

            const report = reports[0];
            expect(report.provider).toBe('Kubecost');
            expect(report.account).toBe(`Kubecost/${instanceName}`);
            expect(report.service).toBe(`Kubecost/${item.name}`);
            expect((report as any).providerType).toBe('Integration');

            // Tags are propagated to the report
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

            // Report contains positive cost data
            const totalCost = (Object.values(report.reports) as number[]).reduce((sum, c) => sum + c, 0);
            expect(totalCost).toBeGreaterThan(0);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('transform invariant: zero/negative costs are never in output', () => {
    it('should exclude allocations with non-positive totalCost', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.tuple(arbAllocationName, fc.oneof(arbPositiveCost, arbNonPositiveCost)), {
            minLength: 1,
            maxLength: 10,
          }),
          arbInstanceName,
          async (items, instanceName) => {
            const timeWindowMap: Record<string, any> = {};
            for (const [name, cost] of items) {
              timeWindowMap[name] = {
                name,
                properties: {},
                totalCost: cost,
                cpuCost: cost,
                start: '2024-01-15T00:00:00Z',
                end: '2024-02-01T00:00:00Z',
              };
            }

            const config = createMockConfig({ name: instanceName });
            const reports = await client.callTransformCostsData(
              config,
              createMockQuery('monthly'),
              wrapCostResponse(timeWindowMap),
            );

            const nonPositiveNames = items.filter(([_, cost]) => cost <= 0).map(([name]) => `Kubecost/${name}`);
            const reportServices = reports.map(r => r.service);
            for (const name of nonPositiveNames) {
              expect(reportServices).not.toContain(name);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('transform invariant: filters control output inclusion', () => {
    function buildTimeWindowMap(names: string[]): Record<string, any> {
      const map: Record<string, any> = {};
      for (const name of names) {
        map[name] = { name, properties: {}, totalCost: 10, cpuCost: 10, start: '2024-01-15T00:00:00Z', end: '2024-02-01T00:00:00Z' };
      }
      return map;
    }

    function filterProperty(filterType: string, assertion: (reports: any[], targetName: string) => void) {
      return fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(arbAllocationName, { minLength: 2, maxLength: 10 }),
          arbInstanceName,
          async (names, instanceName) => {
            const targetName = names[0];
            const config = createMockConfig({
              name: instanceName,
              filters: [{ type: filterType, attribute: 'name', pattern: `^${escapeRegex(targetName)}$` }],
            });
            const reports = await client.callTransformCostsData(
              config,
              createMockQuery('monthly'),
              wrapCostResponse(buildTimeWindowMap(names)),
            );
            assertion(reports, targetName);
          },
        ),
        { numRuns: 100 },
      );
    }

    it('should exclude items matching exclude filters', async () => {
      await filterProperty('exclude', (reports, targetName) => {
        expect(reports.map(r => r.service)).not.toContain(`Kubecost/${targetName}`);
      });
    });

    it('should only include items matching include filters', async () => {
      await filterProperty('include', (reports, targetName) => {
        for (const report of reports) {
          expect(report.service.replace('Kubecost/', '')).toBe(targetName);
        }
      });
    });
  });
});
