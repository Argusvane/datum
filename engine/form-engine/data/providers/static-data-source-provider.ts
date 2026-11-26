import type {
  DataSourceContext,
  LocalizedText,
  DataSourceProvider,
  DataSourceRequest,
  DataSourceResult
} from "../../core/schema/contracts.js";

export interface StaticDataSourceItem {
  value: string;
  /** Plain, or localized (`{ default, locales, key }`): resolved in the filler's locale when drawn. */
  label: LocalizedText;
  description?: LocalizedText;
  meta?: Record<string, unknown>;
}

export interface DataSourceProviderOptions {
  environments?: NonNullable<DataSourceProvider["environments"]>;
  privileges?: NonNullable<DataSourceProvider["privileges"]>;
}

export class StaticDataSourceProvider implements DataSourceProvider {
  public readonly environments?: NonNullable<DataSourceProvider["environments"]>;
  public readonly privileges?: NonNullable<DataSourceProvider["privileges"]>;

  constructor(
    public readonly id: string,
    private readonly items: StaticDataSourceItem[],
    options: DataSourceProviderOptions = {}
  ) {
    if (options.environments) {
      this.environments = options.environments;
    }
    if (options.privileges) {
      this.privileges = options.privileges;
    }
  }

  public async load(
    _request: DataSourceRequest,
    _context: DataSourceContext
  ): Promise<DataSourceResult> {
    return {
      items: this.items.map((item) => ({ ...item }))
    };
  }
}
