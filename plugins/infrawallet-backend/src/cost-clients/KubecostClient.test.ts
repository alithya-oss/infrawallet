/**
 * @file KubecostClient.test.ts
 * @description Unit and property-based tests for the KubecostClient cost integration.
 *
 * This test suite validates:
 * - Client initialization and configuration parsing
 * - URL construction for different Kubecost API versions (v1, v2, v3)
 * - Cost data transformation from Kubecost allocation format to InfraWallet reports
 * - Filtering, error handling, and retention window clamping
 * - Property-based invariants using fast-check for randomized input validation
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

// Mock CategoryMappingService singleton
jest.mock('../service/CategoryMappingService', () => ({
  CategoryMappingService: {
    getInstance: () => ({
      getCategoryByServiceName: (_provider: any, serviceName: any) => `category-${serviceName}`,
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
import { CostQuery } from '../service/types';

// ─── Test Helpers ────────────────────────────────────────────────────────────

/**
 * Creates a testable KubecostClient instance by exposing protected methods
 * through a public wrapper interface.
 *
 * @param {any} clientInstance - The KubecostClient instance to wrap
 * @returns An object with callable wrappers for protected methods
 */
function createTestableClient(clientInstance: any) {
  return {
    callTransformCostsData: (subAccountConfig: Config, query: CostQuery, costResponse: any): Promise<any[]> =>
      clientInstance.transformCostsData(subAccountConfig, query, costResponse),
    callFetchCosts: (subAccountConfig: Config, client: any, query: CostQuery): Promise<any> =>
      clientInstance.fetchCosts(subAccountConfig, client, query),
    callInitCloudClient: (subAccountConfig: Config): Promise<any> => clientInstance.initCloudClient(subAccountConfig),
  };
}

/** @typedef {ReturnType<typeof createTestableClient>} TestableClient */
type TestableClient = ReturnType<typeof createTestableClient>;

/**
 * Creates a mock Backstage Config object with the given values.
 * Simulates the Config interface for testing without requiring real YAML parsing.
 *
 * @param {object} values - Configuration values to mock
 * @param {string} values.name - The Kubecost instance name
 * @param {string} [values.baseUrl] - The Kubecost API base URL (defaults to https://kubecost.example.com)
 * @param {string} [values.apiVersion] - The Kubecost API version (v1, v2, or v3)
 * @param {string} [values.aggregate] - The allocation aggregation dimension (e.g., namespace, deployment)
 * @param {string[]} [values.tags] - Tag key:value pairs to extract from allocations
 * @param {object} [values.maxMetricsRetention] - Custom retention window configuration
 * @param {number} [values.maxMetricsRetention.days] - Retention in days
 * @param {number} [values.maxMetricsRetention.hours] - Retention in hours
 * @param {Array<{type: string, attribute: string, pattern: string}>} [values.filters] - Include/exclude filters
 * @returns {Config} A mocked Config object
 */
function createMockConfig(values: {
  name: string;
  baseUrl?: string;
  apiVersion?: string;
  aggregate?: string;
  tags?: string[];
  maxMetricsRetention?: { days?: number; hours?: number };
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

  const retentionConfig = values.maxMetricsRetention
    ? {
        has: () => true,
        getOptionalNumber: (key: string) => {
          if (key === 'days') return values.maxMetricsRetention?.days;
          if (key === 'hours') return values.maxMetricsRetention?.hours;
          return undefined;
        },
        getNumber: (key: string) => {
          if (key === 'days') return values.maxMetricsRetention?.days ?? 0;
          if (key === 'hours') return values.maxMetricsRetention?.hours ?? 0;
          return 0;
        },
      }
    : undefined;

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
    has: (key: string) => {
      if (key === 'maxMetricsRetention') return !!values.maxMetricsRetention;
      return false;
    },
    getConfig: (key: string) => {
      if (key === 'maxMetricsRetention') return retentionConfig;
      throw new Error(`Unknown config key: ${key}`);
    },
  } as unknown as Config;
}

/**
 * Creates a mock CostQuery object for testing.
 *
 * @param {'daily' | 'monthly'} granularity - The time granularity for cost aggregation
 * @param {string} [startTime] - Start time as Unix milliseconds string (defaults to 2024-01-01)
 * @param {string} [endTime] - End time as Unix milliseconds string (defaults to 2024-02-01)
 * @returns {CostQuery} A mock query object
 */
function createMockQuery(granularity: 'daily' | 'monthly', startTime?: string, endTime?: string): CostQuery {
  return {
    filters: '',
    tags: '',
    groups: '',
    granularity: granularity as any,
    startTime: startTime || '1704067200000', // 2024-01-01
    endTime: endTime || '1706745600000', // 2024-02-01
  };
}

/**
 * Creates a fully initialized testable KubecostClient instance with mocked dependencies.
 * Sets up mock config, database, cache, and logger to isolate the client logic.
 *
 * @returns {TestableClient} A testable client wrapper with exposed protected methods
 */
function createTestClient(): TestableClient {
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

  const instance = KubecostClient.create(mockConfig, mockDatabase, mockCache, mockLogger);
  return createTestableClient(instance);
}

// ─── Arbitrary Generators ────────────────────────────────────────────────────

/**
 * Generates a valid Kubecost allocation item name.
 * Names start with a lowercase letter followed by up to 30 alphanumeric characters or hyphens.
 *
 * @type {fc.Arbitrary<string>}
 */
const arbAllocationName = fc.stringMatching(/^[a-z][a-z0-9-]{0,30}$/);

/**
 * Generates a valid Kubecost instance name.
 * Names start with a lowercase letter followed by up to 20 alphanumeric characters or hyphens.
 *
 * @type {fc.Arbitrary<string>}
 */
const arbInstanceName = fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/);

/**
 * Generates a positive cost value between 0.01 and 100,000.
 * Used to represent valid billable allocation costs.
 *
 * @type {fc.Arbitrary<number>}
 */
const arbPositiveCost = fc.double({ min: 0.01, max: 100000, noNaN: true });

/**
 * Generates a non-positive cost value (zero or negative).
 * Used to test that zero/negative costs are properly excluded from reports.
 *
 * @type {fc.Arbitrary<number>}
 */
const arbNonPositiveCost = fc.oneof(fc.constant(0), fc.double({ min: -100000, max: -0.01, noNaN: true }));

/**
 * Generates a valid ISO 8601 timestamp string between 2020 and 2025.
 * Used for allocation start/end timestamps.
 *
 * @type {fc.Arbitrary<string>}
 */
const arbTimestamp = fc
  .date({
    min: new Date('2020-01-01T00:00:00Z'),
    max: new Date('2025-12-31T23:59:59Z'),
  })
  .map(d => d.toISOString());

/**
 * Generates a valid Kubecost allocation item with configurable totalCost.
 * Includes all cost breakdown fields (cpu, gpu, ram, pv, network, shared, loadBalancer)
 * plus metadata (name, properties, start/end timestamps).
 *
 * @param {fc.Arbitrary<number>} totalCost - Arbitrary for the totalCost field value
 * @returns {fc.Arbitrary<object>} An arbitrary that produces allocation item objects
 */
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

/**
 * Generates tag strings in "key:value" format.
 * Keys are 1-10 lowercase letters, values are 1-10 lowercase alphanumeric characters.
 *
 * @type {fc.Arbitrary<string>}
 */
const arbTag = fc
  .tuple(fc.stringMatching(/^[a-z]{1,10}$/), fc.stringMatching(/^[a-z0-9]{1,10}$/))
  .map(([k, v]) => `${k}:${v}`);

/**
 * Generates an array of 0 to 5 tag strings.
 *
 * @type {fc.Arbitrary<string[]>}
 */
const arbTags = fc.array(arbTag, { minLength: 0, maxLength: 5 });

/**
 * Generates a valid Kubecost API version string (v1, v2, or v3).
 *
 * @type {fc.Arbitrary<string>}
 */
const arbApiVersion = fc.constantFrom('v1', 'v2', 'v3');

// ─── Utility Functions ───────────────────────────────────────────────────────

/**
 * Escapes special regex characters in a string to produce a safe literal pattern.
 *
 * @param {string} str - The string to escape
 * @returns {string} The escaped string safe for use in a RegExp constructor
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Unit Tests ──────────────────────────────────────────────────────────────

describe('KubecostClient Unit Tests', () => {
  let client: TestableClient;

  beforeEach(() => {
    client = createTestClient();
  });

  describe('initCloudClient', () => {
    it('should extract baseUrl, name, and default apiVersion to v1', async () => {
      const config = createMockConfig({ name: 'my-cluster', baseUrl: 'https://kubecost-api.example.com' });
      const result = await client.callInitCloudClient(config);
      expect(result.baseUrl).toBe('https://kubecost-api.example.com');
      expect(result.name).toBe('my-cluster');
      expect(result.apiVersion).toBe('v1');
    });

    it('should use configured apiVersion when provided', async () => {
      for (const version of ['v1', 'v2', 'v3']) {
        const config = createMockConfig({
          name: 'test',
          baseUrl: 'https://kubecost-cost-analyzer.example.com',
          apiVersion: version,
        });
        const result = await client.callInitCloudClient(config);
        expect(result.apiVersion).toBe(version);
      }
    });

    it('should throw on invalid apiVersion', async () => {
      const config = createMockConfig({
        name: 'test',
        baseUrl: 'https://kubecost-cost-analyzer.example.com',
        apiVersion: 'invalid',
      });
      await expect(client.callInitCloudClient(config)).rejects.toThrow(/invalid apiVersion/);
    });
  });

  describe('fetchCosts - URL construction per API version', () => {
    let originalFetch: typeof global.fetch;
    let capturedUrl: string;

    beforeEach(() => {
      capturedUrl = '';
      originalFetch = global.fetch;
      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        capturedUrl = url;
        return {
          ok: true,
          json: async () => ({ code: 200, data: [] }),
        };
      }) as any;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should use /model/allocation with accumulate=true for v1 monthly', async () => {
      const config = createMockConfig({ name: 'kc', baseUrl: 'https://kubecost-api.example.com' });
      const now = Date.now();
      const query = createMockQuery('monthly', (now - 3600000).toString(), now.toString());
      const httpClient = { baseUrl: 'https://kubecost-api.example.com', name: 'kc', apiVersion: 'v1' as const };

      await client.callFetchCosts(config, httpClient, query);

      expect(capturedUrl).toContain('/model/allocation?');
      expect(capturedUrl).toContain('accumulate=true');
      expect(capturedUrl).toContain('idle=false');
    });

    it('should use /model/allocation with accumulate=false for v1 daily', async () => {
      const config = createMockConfig({ name: 'kc', baseUrl: 'https://kubecost-api.example.com' });
      const now = Date.now();
      const query = createMockQuery('daily', (now - 3600000).toString(), now.toString());
      const httpClient = { baseUrl: 'https://kubecost-api.example.com', name: 'kc', apiVersion: 'v1' as const };

      await client.callFetchCosts(config, httpClient, query);

      expect(capturedUrl).toContain('/model/allocation?');
      expect(capturedUrl).toContain('accumulate=false');
    });

    it('should use /model/allocation with accumulate=month for v2 monthly', async () => {
      const config = createMockConfig({ name: 'kc', baseUrl: 'https://kubecost-api.example.com' });
      const now = Date.now();
      const query = createMockQuery('monthly', (now - 3600000).toString(), now.toString());
      const httpClient = { baseUrl: 'https://kubecost-api.example.com', name: 'kc', apiVersion: 'v2' as const };

      await client.callFetchCosts(config, httpClient, query);

      expect(capturedUrl).toContain('/model/allocation?');
      expect(capturedUrl).toContain('accumulate=month');
      expect(capturedUrl).toContain('idle=false');
    });

    it('should use /model/allocation with accumulate=day for v2 daily', async () => {
      const config = createMockConfig({ name: 'kc', baseUrl: 'https://kubecost-api.example.com' });
      const now = Date.now();
      const query = createMockQuery('daily', (now - 3600000).toString(), now.toString());
      const httpClient = { baseUrl: 'https://kubecost-api.example.com', name: 'kc', apiVersion: 'v2' as const };

      await client.callFetchCosts(config, httpClient, query);

      expect(capturedUrl).toContain('accumulate=day');
    });

    it('should use same URL pattern for v3 as v2', async () => {
      const config = createMockConfig({ name: 'kc', baseUrl: 'https://kubecost-api.example.com' });
      const now = Date.now();
      const query = createMockQuery('monthly', (now - 3600000).toString(), now.toString());
      const httpClient = { baseUrl: 'https://kubecost-api.example.com', name: 'kc', apiVersion: 'v3' as const };

      await client.callFetchCosts(config, httpClient, query);

      expect(capturedUrl).toContain('/model/allocation?');
      expect(capturedUrl).toContain('accumulate=month');
      expect(capturedUrl).toContain('idle=false');
    });

    it('should use namespace as default aggregate', async () => {
      const config = createMockConfig({ name: 'kc', baseUrl: 'https://kubecost-api.example.com' });
      const now = Date.now();
      const query = createMockQuery('daily', (now - 3600000).toString(), now.toString());
      const httpClient = { baseUrl: 'https://kubecost-api.example.com', name: 'kc', apiVersion: 'v1' as const };

      await client.callFetchCosts(config, httpClient, query);

      expect(capturedUrl).toContain('aggregate=namespace');
    });

    it('should use configured aggregate value', async () => {
      const config = createMockConfig({
        name: 'kc',
        baseUrl: 'https://kubecost-api.example.com',
        aggregate: 'deployment',
      });
      const now = Date.now();
      const query = createMockQuery('daily', (now - 3600000).toString(), now.toString());
      const httpClient = { baseUrl: 'https://kubecost-api.example.com', name: 'kc', apiVersion: 'v1' as const };

      await client.callFetchCosts(config, httpClient, query);

      expect(capturedUrl).toContain('aggregate=deployment');
    });
  });

  describe('fetchCosts - window parameter', () => {
    let originalFetch: typeof global.fetch;
    let capturedUrl: string;

    beforeEach(() => {
      capturedUrl = '';
      originalFetch = global.fetch;
      global.fetch = jest.fn().mockImplementation(async (url: string) => {
        capturedUrl = url;
        return {
          ok: true,
          json: async () => ({ code: 200, data: [] }),
        };
      }) as any;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should format window as Unix timestamps', async () => {
      const config = createMockConfig({ name: 'kc', baseUrl: 'https://kubecost-api.example.com' });
      const now = Date.now();
      const query = createMockQuery('daily', (now - 3600000).toString(), now.toString());
      const httpClient = { baseUrl: 'https://kubecost-api.example.com', name: 'kc', apiVersion: 'v1' as const };

      await client.callFetchCosts(config, httpClient, query);

      const urlObj = new URL(capturedUrl);
      const windowParam = urlObj.searchParams.get('window')!;
      const parts = windowParam.split(',');
      expect(parts).toHaveLength(2);

      // Both parts should be numeric Unix timestamps (seconds)
      expect(Number(parts[0])).not.toBeNaN();
      expect(Number(parts[1])).not.toBeNaN();
      expect(Number(parts[0])).toBeLessThan(Number(parts[1]));
    });

    it('should clamp start time to retention window', async () => {
      const config = createMockConfig({ name: 'kc', baseUrl: 'https://kubecost-api.example.com' });
      // Request data from 30 days ago (exceeds 15-day default retention)
      const now = Date.now();
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
      const query = createMockQuery('daily', thirtyDaysAgo.toString(), now.toString());
      const httpClient = { baseUrl: 'https://kubecost-api.example.com', name: 'kc', apiVersion: 'v1' as const };

      await client.callFetchCosts(config, httpClient, query);

      const urlObj = new URL(capturedUrl);
      const windowParam = urlObj.searchParams.get('window')!;
      const parts = windowParam.split(',');
      const startTimestamp = Number(parts[0]);

      // Start should be clamped: no older than (15 days - 1 hour buffer) ago
      const maxRetentionSec = (15 * 24 - 1) * 3600; // 15 days minus 1 hour in seconds
      const oldestAllowedSec = Math.floor(now / 1000) - maxRetentionSec;
      // Allow 5 seconds tolerance for test execution time
      expect(startTimestamp).toBeGreaterThanOrEqual(oldestAllowedSec - 5);
      // Should not be the original 30 days ago
      expect(startTimestamp).toBeGreaterThan(Math.floor(thirtyDaysAgo / 1000));
    });
  });

  describe('fetchCosts - error handling', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should throw on HTTP error status', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      }) as any;

      const config = createMockConfig({ name: 'kc', baseUrl: 'https://kubecost-api.example.com' });
      const now = Date.now();
      const query = createMockQuery('daily', (now - 3600000).toString(), now.toString());
      const httpClient = { baseUrl: 'https://kubecost-api.example.com', name: 'kc', apiVersion: 'v1' as const };

      await expect(client.callFetchCosts(config, httpClient, query)).rejects.toThrow(/HTTP 403/);
    });

    it('should throw on API-level error code', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 500, status: 'error', data: null }),
      }) as any;

      const config = createMockConfig({ name: 'kc', baseUrl: 'https://kubecost-api.example.com' });
      const now = Date.now();
      const query = createMockQuery('daily', (now - 3600000).toString(), now.toString());
      const httpClient = { baseUrl: 'https://kubecost-api.example.com', name: 'kc', apiVersion: 'v1' as const };

      await expect(client.callFetchCosts(config, httpClient, query)).rejects.toThrow(/code 500/);
    });

    it('should not throw when code field is absent', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      }) as any;

      const config = createMockConfig({ name: 'kc', baseUrl: 'https://kubecost-api.example.com' });
      const now = Date.now();
      const query = createMockQuery('daily', (now - 3600000).toString(), now.toString());
      const httpClient = { baseUrl: 'https://kubecost-api.example.com', name: 'kc', apiVersion: 'v1' as const };

      await expect(client.callFetchCosts(config, httpClient, query)).resolves.toBeDefined();
    });
  });

  describe('transformCostsData - internal allocations', () => {
    it('should skip __idle__ allocations', async () => {
      const config = createMockConfig({ name: 'test' });
      const query = createMockQuery('monthly');
      const costResponse = {
        code: 200,
        data: [
          {
            __idle__: {
              name: '__idle__',
              totalCost: 100,
              start: '2024-01-15T00:00:00Z',
              end: '2024-02-01T00:00:00Z',
              properties: {},
            },
            'my-app': {
              name: 'my-app',
              totalCost: 50,
              start: '2024-01-15T00:00:00Z',
              end: '2024-02-01T00:00:00Z',
              properties: {},
            },
          },
        ],
      };

      const reports = await client.callTransformCostsData(config, query, costResponse);
      const services = reports.map(r => r.service);
      expect(services).not.toContain('Kubecost/__idle__');
      expect(services).toContain('Kubecost/my-app');
    });

    it('should skip __unallocated__ allocations', async () => {
      const config = createMockConfig({ name: 'test' });
      const query = createMockQuery('monthly');
      const costResponse = {
        code: 200,
        data: [
          {
            __unallocated__: {
              name: '__unallocated__',
              totalCost: 100,
              start: '2024-01-15T00:00:00Z',
              end: '2024-02-01T00:00:00Z',
              properties: {},
            },
          },
        ],
      };

      const reports = await client.callTransformCostsData(config, query, costResponse);
      expect(reports).toHaveLength(0);
    });
  });

  describe('transformCostsData - data normalization', () => {
    it('should handle data as array (Kubecost format)', async () => {
      const config = createMockConfig({ name: 'test' });
      const query = createMockQuery('monthly');
      const costResponse = {
        code: 200,
        data: [
          { ns1: { totalCost: 10, start: '2024-01-15T00:00:00Z', end: '2024-02-01T00:00:00Z', properties: {} } },
          { ns1: { totalCost: 20, start: '2024-02-15T00:00:00Z', end: '2024-03-01T00:00:00Z', properties: {} } },
        ],
      };

      const reports = await client.callTransformCostsData(config, query, costResponse);
      expect(reports.length).toBe(1);
      expect(reports[0].reports['2024-01']).toBe(10);
      expect(reports[0].reports['2024-02']).toBe(20);
    });

    it('should handle data as single object (non-array format)', async () => {
      const config = createMockConfig({ name: 'test' });
      const query = createMockQuery('monthly');
      const costResponse = {
        code: 200,
        data: { ns1: { totalCost: 10, start: '2024-01-15T00:00:00Z', end: '2024-02-01T00:00:00Z', properties: {} } },
      };

      const reports = await client.callTransformCostsData(config, query, costResponse);
      expect(reports.length).toBe(1);
      expect(reports[0].reports['2024-01']).toBe(10);
    });

    it('should skip null entries in data array', async () => {
      const config = createMockConfig({ name: 'test' });
      const query = createMockQuery('monthly');
      const costResponse = {
        code: 200,
        data: [
          null,
          { ns1: { totalCost: 10, start: '2024-01-15T00:00:00Z', end: '2024-02-01T00:00:00Z', properties: {} } },
        ],
      };

      const reports = await client.callTransformCostsData(config, query, costResponse);
      expect(reports.length).toBe(1);
    });

    it('should skip items with invalid start timestamps', async () => {
      const config = createMockConfig({ name: 'test' });
      const query = createMockQuery('monthly');
      const costResponse = {
        code: 200,
        data: [
          {
            'bad-ts': { totalCost: 10, start: 'not-a-date', end: '2024-02-01T00:00:00Z', properties: {} },
            'good-ts': { totalCost: 10, start: '2024-01-15T00:00:00Z', end: '2024-02-01T00:00:00Z', properties: {} },
          },
        ],
      };

      const reports = await client.callTransformCostsData(config, query, costResponse);
      const services = reports.map(r => r.service);
      expect(services).not.toContain('Kubecost/bad-ts');
      expect(services).toContain('Kubecost/good-ts');
    });
  });
});

// ─── Property-Based Tests ────────────────────────────────────────────────────

describe('KubecostClient Property-Based Tests', () => {
  let client: TestableClient;

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
              data: [{ [item.name]: item }],
            };

            const reports = await client.callTransformCostsData(config, query, costResponse);

            expect(reports.length).toBeGreaterThanOrEqual(1);

            const report = reports[0];
            expect(report.provider).toBe('Kubecost');
            expect(report.account).toBe(`Kubecost/${instanceName}`);
            expect(report.service).toBe(`Kubecost/${item.name}`);
            expect(report.category).toBe(`category-${item.name}`);
            expect((report as any).providerType).toBe('Integration');

            // All configured tags are present
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
            const totalReportCost = (Object.values(report.reports) as number[]).reduce((sum, c) => sum + c, 0);
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
          fc.array(fc.tuple(arbAllocationName, fc.oneof(arbPositiveCost, arbNonPositiveCost)), {
            minLength: 1,
            maxLength: 10,
          }),
          arbInstanceName,
          async (items, instanceName) => {
            const config = createMockConfig({ name: instanceName });
            const query = createMockQuery('monthly');

            const timeWindowMap: Record<string, any> = {};
            for (const [name, cost] of items) {
              timeWindowMap[name] = {
                name,
                properties: {},
                totalCost: cost,
                start: '2024-01-15T00:00:00Z',
                end: '2024-02-01T00:00:00Z',
              };
            }

            const costResponse = { code: 200, data: [timeWindowMap] };
            const reports = await client.callTransformCostsData(config, query, costResponse);

            // No report should have a service name from a non-positive cost item
            const nonPositiveNames = items.filter(([_, cost]) => cost <= 0).map(([name]) => `Kubecost/${name}`);
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
        fc.asyncProperty(arbAllocationItem(arbPositiveCost), arbInstanceName, async (item, instanceName) => {
          const config = createMockConfig({ name: instanceName });
          const query = createMockQuery('monthly');
          const costResponse = { code: 200, data: [{ [item.name]: item }] };

          const reports = await client.callTransformCostsData(config, query, costResponse);

          for (const report of reports) {
            for (const periodKey of Object.keys(report.reports)) {
              expect(periodKey).toMatch(/^\d{4}-\d{2}$/);
            }
          }
        }),
        { numRuns: 100 },
      );
    });

    it('should produce YYYY-MM-DD period keys for daily granularity', async () => {
      await fc.assert(
        fc.asyncProperty(arbAllocationItem(arbPositiveCost), arbInstanceName, async (item, instanceName) => {
          const config = createMockConfig({ name: instanceName });
          const query = createMockQuery('daily');
          const costResponse = { code: 200, data: [{ [item.name]: item }] };

          const reports = await client.callTransformCostsData(config, query, costResponse);

          for (const report of reports) {
            for (const periodKey of Object.keys(report.reports)) {
              expect(periodKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            }
          }
        }),
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
            const excludeName = names[0];
            const config = createMockConfig({
              name: instanceName,
              filters: [{ type: 'exclude', attribute: 'name', pattern: `^${escapeRegex(excludeName)}$` }],
            });
            const query = createMockQuery('monthly');

            const timeWindowMap: Record<string, any> = {};
            for (const name of names) {
              timeWindowMap[name] = {
                name,
                properties: {},
                totalCost: 10,
                start: '2024-01-15T00:00:00Z',
                end: '2024-02-01T00:00:00Z',
              };
            }

            const costResponse = { code: 200, data: [timeWindowMap] };
            const reports = await client.callTransformCostsData(config, query, costResponse);
            const reportServiceNames = reports.map(r => r.service);
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
            const includeName = names[0];
            const config = createMockConfig({
              name: instanceName,
              filters: [{ type: 'include', attribute: 'name', pattern: `^${escapeRegex(includeName)}$` }],
            });
            const query = createMockQuery('monthly');

            const timeWindowMap: Record<string, any> = {};
            for (const name of names) {
              timeWindowMap[name] = {
                name,
                properties: {},
                totalCost: 10,
                start: '2024-01-15T00:00:00Z',
                end: '2024-02-01T00:00:00Z',
              };
            }

            const costResponse = { code: 200, data: [timeWindowMap] };
            const reports = await client.callTransformCostsData(config, query, costResponse);

            for (const report of reports) {
              expect(report.service.replace('Kubecost/', '')).toBe(includeName);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ─── Property 5: Window parameter formatting ───────────────────────────────

  describe('Property 5: Window parameter uses Unix timestamps', () => {
    it('should construct a window parameter with two Unix timestamps separated by a comma', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Use recent timestamps within the retention window to avoid clamping
          fc.integer({ min: Math.floor(Date.now() / 1000) - 12 * 3600, max: Math.floor(Date.now() / 1000) - 3600 }),
          fc.integer({ min: Math.floor(Date.now() / 1000) - 3600, max: Math.floor(Date.now() / 1000) }),
          arbApiVersion,
          async (startSec, endSec, apiVersion) => {
            if (startSec >= endSec) return;

            let capturedUrl = '';
            const originalFetch = global.fetch;
            global.fetch = jest.fn().mockImplementation(async (url: string) => {
              capturedUrl = url;
              return { ok: true, json: async () => ({ code: 200, data: [] }) };
            }) as any;

            try {
              const config = createMockConfig({ name: 'test', baseUrl: 'https://kubecost.example.com' });
              const query = createMockQuery('monthly', (startSec * 1000).toString(), (endSec * 1000).toString());
              const httpClient = { baseUrl: 'https://kubecost.example.com', name: 'test', apiVersion };

              await client.callFetchCosts(config, httpClient, query);

              const urlObj = new URL(capturedUrl);
              const windowParam = urlObj.searchParams.get('window');
              expect(windowParam).toBeDefined();

              const parts = windowParam!.split(',');
              expect(parts).toHaveLength(2);

              // Both parts should be valid numeric Unix timestamps (seconds)
              const parsedStart = Number(parts[0]);
              const parsedEnd = Number(parts[1]);
              expect(parsedStart).not.toBeNaN();
              expect(parsedEnd).not.toBeNaN();
              expect(parsedStart).toBeLessThanOrEqual(parsedEnd);
              // Timestamps should be in seconds (not milliseconds)
              expect(parsedStart).toBeLessThan(2000000000);
              expect(parsedEnd).toBeLessThan(2000000000);
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
