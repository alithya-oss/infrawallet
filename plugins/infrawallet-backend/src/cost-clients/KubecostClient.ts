import { CacheService, DatabaseService, LoggerService } from '@backstage/backend-plugin-api';
import { Config, readDurationFromConfig } from '@backstage/config';
import { durationToMilliseconds, HumanDuration } from '@backstage/types';
import { DateTime } from 'luxon';
import { CostQuery, Report } from '../service/types';
import { InfraWalletClient } from './InfraWalletClient';
import { CategoryMappingService } from '../service/CategoryMappingService';
import { CLOUD_PROVIDER, GRANULARITY, PROVIDER_TYPE } from '../service/consts';
import { KubecostAllocationResponseSchema } from '../schemas/KubecostBilling';
import { ZodError } from 'zod';

/**
 * Supported API versions:
 * - 'v1': Kubecost 1.x (endpoint: /model/allocation, accumulate as boolean)
 * - 'v2': Kubecost 2.x (endpoint: /model/allocation, accumulate as string, v2 filter support)
 * - 'v3': Kubecost 3.x (same API as v2, endpoint: /model/allocation)
 */
type KubecostApiVersion = 'v1' | 'v2' | 'v3';

interface KubecostHttpClient {
  baseUrl: string;
  name: string;
  apiVersion: KubecostApiVersion;
}

export class KubecostClient extends InfraWalletClient {
  static create(config: Config, database: DatabaseService, cache: CacheService, logger: LoggerService) {
    return new KubecostClient(CLOUD_PROVIDER.KUBECOST, config, database, cache, logger);
  }

  protected convertServiceName(serviceName: string): string {
    return `Kubecost/${serviceName}`;
  }

  protected async initCloudClient(subAccountConfig: Config): Promise<KubecostHttpClient> {
    const baseUrl = subAccountConfig.getString('baseUrl');
    const name = subAccountConfig.getString('name');
    const apiVersion = (subAccountConfig.getOptionalString('apiVersion') || 'v1') as KubecostApiVersion;

    if (!['v1', 'v2', 'v3'].includes(apiVersion)) {
      throw new Error(
        `Kubecost: invalid apiVersion "${apiVersion}" for instance "${name}". Must be one of: v1, v2, v3`,
      );
    }

    return { baseUrl, name, apiVersion };
  }

  /**
   * Builds the allocation API URL based on the API version.
   */
  private buildAllocationUrl(client: KubecostHttpClient, window: string, aggregate: string, query: CostQuery): string {
    const params = new URLSearchParams();
    params.set('window', window);
    params.set('aggregate', aggregate);

    switch (client.apiVersion) {
      case 'v1': {
        // Kubecost v1.x uses /model/allocation with accumulate as boolean
        // see: https://www.ibm.com/docs/en/kubecost/self-hosted/1.x?topic=directory-allocation-api
        const accumulate = query.granularity === GRANULARITY.MONTHLY ? 'true' : 'false';
        params.set('accumulate', accumulate);
        params.set('idle', 'false');
        return `${client.baseUrl}/model/allocation?${params.toString()}`;
      }
      case 'v2':
      case 'v3': {
        // Kubecost v2.x/v3.x uses /model/allocation with accumulate as string duration
        // see: https://www.ibm.com/docs/en/kubecost/self-hosted/2.x?topic=apis-allocation-api
        const accumulate = query.granularity === GRANULARITY.MONTHLY ? 'month' : 'day';
        params.set('accumulate', accumulate);
        params.set('idle', 'false');
        return `${client.baseUrl}/model/allocation?${params.toString()}`;
      }
      default:
        throw new Error(`Unsupported apiVersion: ${client.apiVersion}`);
    }
  }

  protected async fetchCosts(subAccountConfig: Config, client: KubecostHttpClient, query: CostQuery): Promise<any> {
    let startDate = DateTime.fromMillis(Number.parseInt(query.startTime, 10), { zone: 'utc' });
    const endDate = DateTime.fromMillis(Number.parseInt(query.endTime, 10), { zone: 'utc' });

    // Kubecost free tier only retains 15 days (360h) of data.
    // Clamp the start time so we don't request beyond the retention window.
    // Subtract a 1-hour buffer to account for clock drift and request latency.
    // see: https://www.ibm.com/docs/en/kubecost/self-hosted/2.x?topic=overview-opencost-product-comparison
    const defaultRetention: HumanDuration = { days: 15 };
    const maxRetention = subAccountConfig.has('maxMetricsRetention')
      ? readDurationFromConfig(subAccountConfig, { key: 'maxMetricsRetention' })
      : defaultRetention;
    const maxRetentionMs = durationToMilliseconds(maxRetention);
    const bufferMs = durationToMilliseconds({ hours: 1 });
    const oldestAllowed = DateTime.utc().minus(maxRetentionMs - bufferMs);

    if (startDate < oldestAllowed) {
      this.logger.info(
        `Kubecost: clamping start time from ${startDate.toISO()} to ${oldestAllowed.toISO()} (retention: ${
          maxRetentionMs / 3600000
        }h)`,
      );
      startDate = oldestAllowed;
    }

    const window = `${Math.floor(startDate.toSeconds())},${Math.floor(endDate.toSeconds())}`;
    const aggregate = subAccountConfig.getOptionalString('aggregate') || 'namespace';

    const url = this.buildAllocationUrl(client, window, aggregate, query);

    this.logger.debug(`Fetching Kubecost costs from URL: ${url} (apiVersion: ${client.apiVersion})`);

    const response = await fetch(url, { method: 'GET' });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Kubecost API request failed for ${client.name} (${client.baseUrl}): HTTP ${response.status} - ${errorText}`,
      );
    }

    const jsonResponse = await response.json();

    // Validate response schema (log warning on failure, continue processing)
    try {
      KubecostAllocationResponseSchema.parse(jsonResponse);
      this.logger.debug(`Kubecost allocation response validation passed`);
    } catch (error) {
      if (error instanceof ZodError) {
        this.logger.warn(`Kubecost allocation response validation failed: ${error.message}`);
      } else {
        this.logger.warn(`Unexpected validation error: ${(error as Error).message}`);
      }
    }

    // Throw if API-level error code (Kubecost returns code: 200 on success)
    if (jsonResponse.code !== undefined && jsonResponse.code !== 200) {
      throw new Error(
        `Kubecost API error for ${client.name}: code ${jsonResponse.code}, status: ${jsonResponse.status}`,
      );
    }

    return jsonResponse;
  }

  protected async transformCostsData(subAccountConfig: Config, query: CostQuery, costResponse: any): Promise<Report[]> {
    const instanceName = subAccountConfig.getString('name');

    if (!costResponse || !costResponse.data) {
      this.logger.warn(`[${instanceName}] No valid Kubecost cost data to transform`);
      return [];
    }

    this.logger.debug(`[${instanceName}] Starting cost data transformation (granularity: ${query.granularity})`);

    const tagKeyValues = this.parseTagConfig(subAccountConfig);
    const dataArray = this.normalizeResponseData(costResponse.data);
    const stats = { total: 0, processed: 0, zeroCost: 0, internal: 0, invalidDate: 0, filtered: 0 };
    const transformedData: Record<string, Report> = {};

    for (const timeWindowMap of dataArray) {
      if (!timeWindowMap || typeof timeWindowMap !== 'object') {
        continue;
      }

      for (const [allocationName, allocationItem] of Object.entries(timeWindowMap)) {
        stats.total++;
        const item = allocationItem as any;

        // Valid object with positive cost
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          continue;
        }
        if (!item.totalCost || item.totalCost <= 0) {
          stats.zeroCost++;
          continue;
        }

        // Skip Kubecost internal allocations
        if (this.isInternalAllocation(allocationName)) {
          stats.internal++;
          continue;
        }

        // Apply user-defined include/exclude filters
        if (!this.evaluateIntegrationFilters(allocationName, subAccountConfig)) {
          stats.filtered++;
          continue;
        }

        // Valid timestamp
        const period = this.extractPeriod(item.start, query.granularity);
        if (!period) {
          this.logger.debug(`[${instanceName}] Skipping "${allocationName}": invalid start timestamp "${item.start}"`);
          stats.invalidDate++;
          continue;
        }

        // Accumulate costs by resource type
        this.accumulateCostFields(item, allocationName, instanceName, period, tagKeyValues, transformedData);
        stats.processed++;
      }
    }

    this.logger.debug(
      `[${instanceName}] Transformation complete: ${stats.processed}/${stats.total} processed, ` +
        `${Object.keys(transformedData).length} reports generated ` +
        `(skipped: ${stats.zeroCost} zero-cost, ${stats.internal} internal, ` +
        `${stats.invalidDate} invalid-date, ${stats.filtered} filtered)`,
    );

    this.logTransformationSummary({
      processed: stats.processed,
      uniqueReports: Object.keys(transformedData).length,
      zeroAmount: stats.zeroCost,
      missingFields: stats.internal,
      invalidDate: stats.invalidDate,
      timeRange: stats.filtered,
      totalRecords: stats.total,
    });

    return Object.values(transformedData);
  }

  /**
   * Parses the `tags` config array into a key-value map.
   * Tags are expected in "key:value" format.
   */
  private parseTagConfig(subAccountConfig: Config): Record<string, string> {
    const tags = subAccountConfig.getOptionalStringArray('tags');
    const result: Record<string, string> = {};
    tags?.forEach(tag => {
      const [k, v] = tag.split(':');
      if (k && v) {
        result[k.trim()] = v.trim();
      }
    });
    return result;
  }

  /**
   * Normalizes the Kubecost response data into a consistent array of time-window maps.
   * Handles both array format (standard) and single-object format (edge case).
   */
  private normalizeResponseData(data: any): Array<Record<string, any>> {
    return Array.isArray(data) ? data : [data];
  }

  /**
   * Checks whether an allocation name is a Kubecost internal entry (e.g., __idle__, __unallocated__).
   */
  private isInternalAllocation(name: string): boolean {
    return name.startsWith('__') && name.endsWith('__');
  }

  /**
   * Extracts the period string from an ISO timestamp based on the query granularity.
   * Returns null if the timestamp is invalid.
   */
  private extractPeriod(isoTimestamp: string, granularity: string): string | null {
    const dt = DateTime.fromISO(isoTimestamp, { zone: 'utc' });
    if (!dt.isValid) {
      return null;
    }
    return granularity === GRANULARITY.MONTHLY ? dt.toFormat('yyyy-MM') : dt.toFormat('yyyy-MM-dd');
  }

  /**
   * Splits an allocation item's costs by resource type and accumulates them
   * into the transformedData map, keyed by instance → category → allocation.
   */
  private accumulateCostFields(
    item: any,
    allocationName: string,
    instanceName: string,
    period: string,
    tagKeyValues: Record<string, string>,
    transformedData: Record<string, Report>,
  ): void {
    const categoryMappingService = CategoryMappingService.getInstance();

    const costFields: Array<{ field: string; cost: number }> = [
      { field: 'cpuCost', cost: item.cpuCost || 0 },
      { field: 'ramCost', cost: item.ramCost || 0 },
      { field: 'gpuCost', cost: item.gpuCost || 0 },
      { field: 'networkCost', cost: item.networkCost || 0 },
      { field: 'loadBalancerCost', cost: item.loadBalancerCost || 0 },
      { field: 'pvCost', cost: item.pvCost || 0 },
      { field: 'sharedCost', cost: item.sharedCost || 0 },
    ];

    for (const { field, cost } of costFields) {
      if (cost <= 0) continue;

      const category = categoryMappingService.getCategoryByServiceName(this.provider, field);
      const key = `${instanceName}->${category}->${allocationName}`;

      if (!transformedData[key]) {
        transformedData[key] = {
          id: key,
          account: `Kubecost/${instanceName}`,
          service: `Kubecost/${allocationName}`,
          category,
          provider: this.provider,
          providerType: PROVIDER_TYPE.INTEGRATION,
          ...tagKeyValues,
          reports: {},
        };
      }

      transformedData[key].reports[period] = (transformedData[key].reports[period] || 0) + cost;
    }
  }
}
