import type {
  CloseLeaseArgs,
  CloseLeaseCallbacks,
  CloseLeaseResult,
  ManageDomainArgs,
  ManageDomainCallbacks,
  ManageDomainResult,
  TroubleshootArgs,
  TroubleshootCallbacks,
  TroubleshootReport,
} from './types.js';

export class NotImplemented extends Error {
  constructor(name: string) {
    super(`${name} is not implemented yet (ENG-129)`);
    this.name = 'NotImplemented';
    Object.setPrototypeOf(this, NotImplemented.prototype);
  }
}

export async function manageDomain(
  _args: ManageDomainArgs,
  _callbacks: ManageDomainCallbacks,
): Promise<ManageDomainResult> {
  throw new NotImplemented('manageDomain');
}

export async function troubleshootDeployment(
  _args: TroubleshootArgs,
  _callbacks: TroubleshootCallbacks,
): Promise<TroubleshootReport> {
  throw new NotImplemented('troubleshootDeployment');
}

export async function closeLease(
  _args: CloseLeaseArgs,
  _callbacks: CloseLeaseCallbacks,
): Promise<CloseLeaseResult> {
  throw new NotImplemented('closeLease');
}
