import { CacheService, LoggerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { promises as fsPromises } from 'fs';
import { CACHE_CATEGORY, DEFAULT_CATEGORY_MAPPING_CACHE_TTL } from './consts';
import { CategoryMappings, ServiceToCategoryMappings } from './types';

const DEFAULT_DATASOURCE_URL =
  'https://raw.githubusercontent.com/electrolux-oss/infrawallet-default-category-mappings/main/default_category_mappings.json';

type DatasourceType = 'file' | 'url';

export class CategoryMappingService {
  private static instance: CategoryMappingService;

  constructor(
    protected readonly cache: CacheService,
    protected readonly logger: LoggerService,
    protected readonly datasourceType: DatasourceType,
    protected readonly datasourceTarget: string,
  ) {}

  static initInstance(cache: CacheService, logger: LoggerService, config?: Config) {
    if (!CategoryMappingService.instance) {
      const datasourceType =
        (config?.getOptionalString('backend.infraWallet.categoryMappings.type') as DatasourceType) ?? 'url';
      const datasourceTarget =
        config?.getOptionalString('backend.infraWallet.categoryMappings.target') ?? DEFAULT_DATASOURCE_URL;
      CategoryMappingService.instance = new CategoryMappingService(cache, logger, datasourceType, datasourceTarget);
    }
  }

  static getInstance(): CategoryMappingService {
    if (!CategoryMappingService.instance) {
      throw new Error('CategoryMappingService needs to be initialized first');
    }
    return CategoryMappingService.instance;
  }

  private categoryMappings: CategoryMappings = {};
  private serviceToCategory: ServiceToCategoryMappings = {};

  private generateServiceToCategoryMappings(categoryMappings: CategoryMappings): ServiceToCategoryMappings {
    const result: ServiceToCategoryMappings = {};
    for (const [category, mappings] of Object.entries(categoryMappings)) {
      for (const [provider, services] of Object.entries(mappings)) {
        const providerLowerCase = provider.toLowerCase();
        if (!(provider in result)) {
          result[providerLowerCase] = {};
        }
        services.forEach(service => {
          result[providerLowerCase][service] = category;
        });
      }
    }
    return result;
  }

  private async fetchCategoryMappings(): Promise<CategoryMappings> {
    switch (this.datasourceType) {
      case 'file':
        return this.loadFromFile(this.datasourceTarget);
      case 'url':
        return this.fetchFromUrl(this.datasourceTarget);
      default:
        this.logger.error(`Unknown category mappings datasource type: ${this.datasourceType}`);
        return {};
    }
  }

  private async loadFromFile(target: string): Promise<CategoryMappings> {
    try {
      const fileContent = await fsPromises.readFile(target, 'utf8');
      const data = JSON.parse(fileContent);
      this.logger.debug(`Category mappings loaded from file: ${target}`);
      return data;
    } catch (error) {
      this.logger.error(`Failed to load category mappings from file "${target}": ${(error as Error).message}`);
      return {};
    }
  }

  private async fetchFromUrl(url: string): Promise<CategoryMappings> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      this.logger.debug(`Category mappings fetched from URL: ${url}`);
      return data as CategoryMappings;
    } catch (error) {
      this.logger.error(`Failed to fetch category mappings from "${url}": ${(error as Error).message}`);
      return {};
    }
  }

  public async refreshCategoryMappings() {
    let categoryMappings = (await this.cache.get(CACHE_CATEGORY.CATEGORY_MAPPINGS)) as CategoryMappings | undefined;
    if (categoryMappings === undefined) {
      // fetch the mappings from the GitHub repo and set it to the cache
      categoryMappings = await this.fetchCategoryMappings();
      await this.cache.set(CACHE_CATEGORY.CATEGORY_MAPPINGS, categoryMappings, {
        ttl: DEFAULT_CATEGORY_MAPPING_CACHE_TTL,
      });
      this.categoryMappings = categoryMappings;
      this.serviceToCategory = this.generateServiceToCategoryMappings(categoryMappings);
    } else {
      this.logger.debug('Reuse the category mappings from cache');
    }
  }

  public getCategoryByServiceName(provider: string, serviceName: string): string {
    const providerLowerCase = provider.toLowerCase();

    if (this.serviceToCategory[providerLowerCase] && serviceName in this.serviceToCategory[providerLowerCase]) {
      return this.serviceToCategory[providerLowerCase][serviceName];
    }

    // do a regex match with service name and then update the serviceToCategory mappings
    let result = 'Uncategorized';
    this.logger.debug(`${serviceName} does not belong to any category, do a regex search in the category mappings`);
    for (const [category, mappings] of Object.entries(this.categoryMappings)) {
      if (providerLowerCase in mappings) {
        for (const service of mappings[providerLowerCase]) {
          const regex = new RegExp(service);
          if (regex.test(serviceName)) {
            this.logger.debug(`${serviceName} belongs to ${category} in regex mode`);
            result = category;
          }
        }
      }
    }

    this.serviceToCategory[providerLowerCase] = this.serviceToCategory[providerLowerCase] || {};
    this.serviceToCategory[providerLowerCase][serviceName] = result;
    this.logger.debug(`serviceToCategoryMappings updated: ${providerLowerCase}/${serviceName} -> ${result}`);

    return result;
  }
}
