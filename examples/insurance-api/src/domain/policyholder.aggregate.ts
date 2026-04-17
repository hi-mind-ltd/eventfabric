import { AggregateRoot, type HandlerMap } from "@eventfabric/core";
import type { PolicyholderEvent } from "./policyholder.events";

export type PolicyholderState = {
  email?: string;
  fullName?: string;
  phone?: string;
  dateOfBirth?: string;
  verified: boolean;
  suspended: boolean;
  kycReference?: string;
  suspensionReason?: string;
};

export class PolicyholderAggregate extends AggregateRoot<PolicyholderState, PolicyholderEvent> {
  static readonly aggregateName = "Policyholder" as const;

  protected handlers = {
    PolicyholderRegistered: (s, e) => {
      s.email = e.email;
      s.fullName = e.fullName;
      s.dateOfBirth = e.dateOfBirth;
      s.verified = false;
      s.suspended = false;
    },
    PolicyholderVerified: (s, e) => {
      s.verified = true;
      s.kycReference = e.kycReference;
    },
    PolicyholderContactUpdated: (s, e) => {
      if (e.email !== undefined) s.email = e.email;
      if (e.phone !== undefined) s.phone = e.phone;
    },
    PolicyholderSuspended: (s, e) => {
      s.suspended = true;
      s.suspensionReason = e.reason;
    }
  } satisfies HandlerMap<PolicyholderEvent, PolicyholderState>;

  constructor(id: string, snapshot?: PolicyholderState) {
    super(id, snapshot ?? { verified: false, suspended: false });
  }

  register(email: string, fullName: string, dateOfBirth: string) {
    if (this.state.email) {
      throw new Error("Policyholder already registered");
    }
    this.raise({
      type: "PolicyholderRegistered",
      version: 1,
      policyholderId: this.id,
      email,
      fullName,
      dateOfBirth
    });
  }

  verify(kycReference: string) {
    if (!this.state.email) {
      throw new Error("Policyholder not registered");
    }
    if (this.state.verified) {
      throw new Error("Policyholder already verified");
    }
    if (this.state.suspended) {
      throw new Error("Cannot verify a suspended policyholder");
    }
    this.raise({
      type: "PolicyholderVerified",
      version: 1,
      policyholderId: this.id,
      kycReference,
      verifiedAt: new Date().toISOString()
    });
  }

  updateContact(changes: { email?: string; phone?: string }) {
    if (!this.state.email) {
      throw new Error("Policyholder not registered");
    }
    if (changes.email === undefined && changes.phone === undefined) {
      throw new Error("At least one of email or phone must be provided");
    }
    this.raise({
      type: "PolicyholderContactUpdated",
      version: 1,
      policyholderId: this.id,
      email: changes.email,
      phone: changes.phone
    });
  }

  suspend(reason: string) {
    if (this.state.suspended) {
      throw new Error("Policyholder already suspended");
    }
    this.raise({
      type: "PolicyholderSuspended",
      version: 1,
      policyholderId: this.id,
      reason,
      suspendedAt: new Date().toISOString()
    });
  }

  get email(): string | undefined {
    return this.state.email;
  }

  get fullName(): string | undefined {
    return this.state.fullName;
  }

  get isVerified(): boolean {
    return this.state.verified;
  }

  get isSuspended(): boolean {
    return this.state.suspended;
  }
}
