import type { ExecuteValidationInput } from '../application/types.js';
import type { WorkflowApp } from '../application/workflow-app.js';

const LOG_EXCERPT_LIMIT = 4_000;

export async function formatValidationResult(
  app: WorkflowApp,
  input: ExecuteValidationInput,
  result: Awaited<ReturnType<WorkflowApp['validation']['run']>>,
): Promise<Record<string, unknown>> {
  const output: Record<string, unknown> = {
    id: result.validation.id,
    status: result.validation.status,
    resultKind: result.validation.resultKind,
    sha: result.validation.sha,
    durationMs: result.validation.durationMs,
    classification: result.classification,
    reused: result.reused,
    itemState: result.itemState,
    actionRequired: result.actionRequired,
    pendingRepositoryKeys: result.pendingRepositoryKeys,
    pendingTestKeys: result.pendingTestKeys,
    logAvailable: Boolean(result.validation.logBlob),
  };

  if (result.validation.logBlob && result.validation.resultKind !== 'PASS') {
    const log = await app.ledger.getValidationLog({
      projectKey: input.projectKey,
      featureKey: input.featureKey,
      itemKey: input.itemKey,
      validationId: result.validation.id,
    });
    output.logExcerpt = excerpt(log.text);
  }

  if (result.actionRequired === 'STRUCTURAL_RED_REASON_REQUIRED') {
    output.nextAction = {
      command: 'validate confirm-red',
      validationId: result.validation.id,
      reasonRequired: true,
      rerunRequired: false,
      note: 'Confirme a evidência estrutural já registrada; não execute o perfil novamente.',
    };
  }

  if (result.actionRequired === 'GREEN_REPOSITORIES_PENDING') {
    output.nextAction = {
      command: 'validate run',
      purpose: 'GREEN',
      repositoryKeys: result.pendingRepositoryKeys ?? [],
      rerunRequired: false,
      note: 'Execute GREEN uma vez em cada repositório autorizado pendente; não repita o perfil já aprovado.',
    };
  }

  if (result.actionRequired === 'GREEN_TEST_EVIDENCE_INCOMPLETE') {
    output.nextAction = {
      command: 'validate run',
      purpose: 'GREEN',
      testKeys: result.pendingTestKeys ?? [],
      rerunRequired: true,
      note: 'Corrija o seletor do teste ou o perfil JSON; GREEN não foi confirmado porque faltou evidência obrigatória.',
    };
  }

  if (result.actionRequired === 'CHECK_TEST_EVIDENCE_INCOMPLETE') {
    output.nextAction = {
      command: 'validate run',
      purpose: 'CHECK',
      testKeys: result.pendingTestKeys ?? [],
      rerunRequired: true,
      note: 'CHECK não correspondeu aos testes planejados; ajuste o seletor ou o perfil JSON e valide novamente.',
    };
  }

  return output;
}

function excerpt(value: string): string {
  if (value.length <= LOG_EXCERPT_LIMIT) {
    return value;
  }

  const side = Math.floor(LOG_EXCERPT_LIMIT / 2);
  return `${value.slice(0, side)}\n… [trecho omitido; use validate log para o log completo] …\n${value.slice(-side)}`;
}
