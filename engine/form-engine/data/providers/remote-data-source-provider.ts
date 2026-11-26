import type {
  DataSourceContext,
  DataSourceProvider,
  DataSourceRequest,
  DataSourceResult,
  LocalizedText
} from "../../core/schema/contracts.js";

export interface HttpDataSourceResponseItem {
  value: string;
  /**
   * Either the text already in the `locale` the request carried, or a localized object holding
   * every language at once; both resolve at render, so the endpoint may answer either way.
   */
  label: LocalizedText;
  description?: LocalizedText;
  meta?: Record<string, unknown>;
}

export interface HttpDataSourceResponse {
  items: HttpDataSourceResponseItem[];
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RemoteDataSourceProviderOptions {
  environments?: NonNullable<DataSourceProvider["environments"]>;
  privileges?: NonNullable<DataSourceProvider["privileges"]>;
}

export class RemoteDataSourceProvider implements DataSourceProvider {
  /** Defaults to both environments; a network-backed provider is typically pinned to `["server"]`. */
  public readonly environments?: NonNullable<DataSourceProvider["environments"]>;
  /** Network-backed by construction. */
  public readonly privileges: NonNullable<DataSourceProvider["privileges"]>;

  constructor(
    public readonly id: string,
    private readonly baseUrl: string,
    private readonly fetcher: FetchLike = fetch,
    options: RemoteDataSourceProviderOptions = {}
  ) {
    if (options.environments) {
      this.environments = options.environments;
    }
    this.privileges = options.privileges ?? { network: true };
  }

  public async load(
    request: DataSourceRequest,
    context: DataSourceContext
  ): Promise<DataSourceResult> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("sourceId", request.sourceId);
    if (context.locale) {
      url.searchParams.set("locale", context.locale);
    }

    const body = JSON.stringify({
      query: request.query ?? {},
      values: context.values ?? {},
      environment: context.environment
    });

    const response = await this.fetcher(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body
    });

    if (!response.ok) {
      throw new Error(`Remote data source request failed: ${response.status}`);
    }

    const payload = (await response.json()) as HttpDataSourceResponse;
    return {
      items: payload.items ?? []
    };
  }
}
