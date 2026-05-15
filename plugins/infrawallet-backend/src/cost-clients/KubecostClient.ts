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
  private buildAllocationUrl(
    client: KubecostHttpClient,
    window: string,
    aggregate: string,
    query: CostQuery,
  ): string {
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
    let startDate = DateTime.fromMillis(parseInt(query.startTime, 10), { zone: 'utc' });
    const endDate = DateTime.fromMillis(parseInt(query.endTime, 10), { zone: 'utc' });

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
        `Kubecost: clamping start time from ${startDate.toISO()} to ${oldestAllowed.toISO()} (retention: ${maxRetentionMs / 3600000}h)`,
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

  protected async transformCostsData(
    subAccountConfig: Config,
    query: CostQuery,
    costResponse: any,
  ): Promise<Report[]> {
    const categoryMappingService = CategoryMappingService.getInstance();
    const instanceName = subAccountConfig.getString('name');
    const integrationConfig = subAccountConfig;

    const tags = subAccountConfig.getOptionalStringArray('tags');
    const tagKeyValues: { [key: string]: string } = {};
    tags?.forEach(tag => {
      const [k, v] = tag.split(':');
      if (k && v) {
        tagKeyValues[k.trim()] = v.trim();
      }
    });

    if (!costResponse || !costResponse.data) {
      this.logger.warn('No valid Kubecost cost data to transform');
      return [];
    }

    // Normalize data: ensure it's always an array of time-window maps
    const dataArray: Array<Record<string, any>> = Array.isArray(costResponse.data)
      ? costResponse.data
      : [costResponse.data];

    // Tracking variables
    let processedRecords = 0;
    let filteredOutZeroCost = 0;
    let filteredOutInternal = 0;
    let filteredOutInvalidDate = 0;
    let filteredOutFilter = 0;
    const uniqueKeys = new Set<string>();
    let totalRecords = 0;

    const transformedData: { [key: string]: Report } = {};

    for (const timeWindowMap of dataArray) {
      if (!timeWindowMap || typeof timeWindowMap !== 'object') {
        continue;
      }

      for (const [allocationName, allocationItem] of Object.entries(timeWindowMap)) {
        const item = allocationItem as any;
        totalRecords++;

        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          continue;
        }

        if (!item.totalCost || item.totalCost <= 0) {
          filteredOutZeroCost++;
          continue;
        }

        if (allocationName.startsWith('__') && allocationName.endsWith('__')) {
          filteredOutInternal++;
          continue;
        }

        if (!this.evaluateIntegrationFilters(allocationName, integrationConfig)) {
          filteredOutFilter++;
          continue;
        }

        const itemStart = DateTime.fromISO(item.start, { zone: 'utc' });
        if (!itemStart.isValid) {
          filteredOutInvalidDate++;
          continue;
        }

        const period = query.granularity === GRANULARITY.MONTHLY
          ? itemStart.toFormat('yyyy-MM')
          : itemStart.toFormat('yyyy-MM-dd');

        // Split costs by resource type using category mappings
        const costFields = [
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
          const keyName = `${instanceName}->${category}->${allocationName}`;

          if (!transformedData[keyName]) {
            uniqueKeys.add(keyName);
            transformedData[keyName] = {
              id: keyName,
              account: `Kubecost/${instanceName}`,
              service: `Kubecost/${allocationName}`,
              category: category,
              provider: this.provider,
              providerType: PROVIDER_TYPE.INTEGRATION,
              ...tagKeyValues,
              reports: {},
            };
          }

          transformedData[keyName].reports[period] =
            (transformedData[keyName].reports[period] || 0) + cost;
        }
        processedRecords++;
      }
    }

    this.logTransformationSummary({
      processed: processedRecords,
      uniqueReports: uniqueKeys.size,
      zeroAmount: filteredOutZeroCost,
      missingFields: filteredOutInternal,
      invalidDate: filteredOutInvalidDate,
      timeRange: filteredOutFilter,
      totalRecords,
    });

    return Object.values(transformedData);
  }
}
