import { AppError } from "../errors/AppError";
import {
  executeIdempotent,
  type IdempotencyStore,
} from "../idempotency/executeIdempotent";
import { invalid, isNonEmptyString, parseUtcTimestamp } from "../procurement/validation";
import { assertCanManage, type ManagementDelegations } from "./managementGuard";
import {
  MAX_BODY_LENGTH,
  templateVariables,
  type TemplateVersion,
  type TemplateVersionRepository,
} from "./messageTemplate";

export type PublishTemplateVersionDeps = {
  templateVersions: TemplateVersionRepository;
  managementDelegations: ManagementDelegations;
  idempotency: IdempotencyStore;
  now?: () => Date;
};

export type PublishTemplateVersionRequest = {
  tenantId: string;
  key: string;
  body: string;
  /** 지금 최신 버전 번호. 첫 발행은 0 */
  expectedVersion: number;
  actorRole: "OWNER" | "STAFF";
  publishedBy: string;
  publishedAt: string;
  idempotencyKey: string;
};

export function publishTemplateVersion(
  deps: PublishTemplateVersionDeps,
  request: PublishTemplateVersionRequest,
): TemplateVersion {
  if (typeof request.key !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(request.key)) {
    invalid("key", "must be upper snake case, up to 64 characters");
  }
  if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 0) {
    invalid("expectedVersion", "must be an integer >= 0");
  }
  if (!isNonEmptyString(request.body) || request.body.length > MAX_BODY_LENGTH) {
    invalid("body", `must be a non-empty string up to ${MAX_BODY_LENGTH} characters`);
  }
  const variables = templateVariables(request.body);
  if (!isNonEmptyString(request.publishedBy)) {
    invalid("publishedBy", "must be a non-empty string");
  }
  const now = (deps.now ?? (() => new Date()))();
  parseUtcTimestamp("publishedAt", request.publishedAt, now);
  assertCanManage(deps.managementDelegations, request, request.publishedBy);
  return executeIdempotent(
    deps.idempotency,
    {
      tenantId: request.tenantId,
      operation: "catalog.publish-template-version",
      key: request.idempotencyKey,
      payload: {
        key: request.key,
        body: request.body,
        expectedVersion: request.expectedVersion,
        publishedBy: request.publishedBy,
        publishedAt: request.publishedAt,
      },
    },
    () => {
      const latest = deps.templateVersions
        .list(request.tenantId, request.key)
        .reduce((max, v) => Math.max(max, v.version), 0);
      if (latest !== request.expectedVersion) {
        throw new AppError("VERSION_CONFLICT");
      }
      const version: TemplateVersion = {
        id: crypto.randomUUID(),
        tenantId: request.tenantId,
        key: request.key,
        version: latest + 1,
        body: request.body,
        variables,
        publishedBy: request.publishedBy,
        publishedAt: request.publishedAt,
        recordedAt: now.toISOString(),
      };
      deps.templateVersions.save(version);
      return version;
    },
  );
}

