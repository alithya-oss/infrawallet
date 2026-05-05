import { CacheService, DatabaseService, LoggerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { CostQuery, Report } from '../service/types';
import { InfraWalletClient } from './InfraWalletClient';
import { CategoryMappingService } from '../service/CategoryMappingService';
import { CLOUD_PROVIDER, GRANULARITY, PROVIDER_TYPE } from '../service/consts';
import { KubecostAllocationResponseSchema } from '../schemas/KubecostBilling';
import { ZodError } from 'zod';

interface KubecostHttpClient {
  baseUrl: string;
  name: string;
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

    return { baseUrl, name };
  }

  protected async fetchCosts(subAccountConfig: Config, client: KubecostHttpClient, query: CostQuery): Promise<any> {
    const startDate = new Date(parseInt(query.startTime, 10)).toISOString().split('T')[0];
    const endDate = new Date(parseInt(query.endTime, 10)).toISOString().split('T')[0];
    const window = `${startDate},${endDate}`;

    const aggregate = subAccountConfig.getOptionalString('aggregate') || 'namespace';
    const accumulate = query.granularity === GRANULARITY.MONTHLY ? 'true' : 'false';

    const url = `${client.baseUrl}/model/allocation?window=${encodeURIComponent(window)}&aggregate=${encodeURIComponent(aggregate)}&accumulate=${accumulate}`;

    this.logger.debug(`Fetching Kubecost costs from URL: ${url}`);

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

    // Throw if API-level error code
    if (jsonResponse.code !== 200) {
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

    // Parse tags from config
    const tags = subAccountConfig.getOptionalStringArray('tags');
    const tagKeyValues: { [key: string]: string } = {};
    tags?.forEach(tag => {
      const [k, v] = tag.split(':');
      if (k && v) {
        tagKeyValues[k.trim()] = v.trim();
      }
    });

    if (!costResponse || !costResponse.data || !Array.isArray(costResponse.data)) {
      this.logger.warn('No valid Kubecost cost data to transform');
      return [];
    }

    const transformedData: { [key: string]: Report } = {};

    for (const timeWindowMap of costResponse.data) {
      for (const [allocationName, allocationItem] of Object.entries(timeWindowMap)) {
        const item = allocationItem as any;

        // Exclude items with zero or negative totalCost
        if (!item.totalCost || item.totalCost <= 0) {
          continue;
        }

        // Apply filter evaluation
        if (!this.evaluateIntegrationFilters(allocationName, integrationConfig)) {
          continue;
        }

        // Derive period key from the allocation item's start timestamp
        const startTimestamp = new Date(item.start);
        let periodKey: string;
        if (query.granularity === GRANULARITY.MONTHLY) {
          const year = startTimestamp.getUTCFullYear();
          const month = String(startTimestamp.getUTCMonth() + 1).padStart(2, '0');
          periodKey = `${year}-${month}`;
        } else {
          const year = startTimestamp.getUTCFullYear();
          const month = String(startTimestamp.getUTCMonth() + 1).padStart(2, '0');
          const day = String(startTimestamp.getUTCDate()).padStart(2, '0');
          periodKey = `${year}-${month}-${day}`;
        }

        const category = categoryMappingService.getCategoryByServiceName(this.provider, allocationName);
        const keyName = `${instanceName}->${category}->${allocationName}`;

        if (!transformedData[keyName]) {
          transformedData[keyName] = {
            id: keyName,
            account: `Kubecost/${instanceName}`,
            service: `Kubecost/${allocationName}`,
            category: category,
            provider: this.provider,
            providerType: PROVIDER_TYPE.INTEGRATION,
            reports: {},
            ...tagKeyValues,
          };
        }

        transformedData[keyName].reports[periodKey] =
          (transformedData[keyName].reports[periodKey] || 0) + item.totalCost;
      }
    }

    return Object.values(transformedData);
  }
}
