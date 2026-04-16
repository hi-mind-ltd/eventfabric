import { AggregateRoot, type HandlerMap } from "@eventfabric/core";
import type { CustomerEvent } from "./customer.events";

export type CustomerState = {
  email?: string;
  name?: string;
  phone?: string;
};

export class CustomerAggregate extends AggregateRoot<CustomerState, CustomerEvent> {
  static readonly aggregateName = "Customer" as const;
  
  protected handlers = {
    CustomerRegistered: (s, e) => {
      s.email = e.email;
      s.name = e.name;
      s.phone = e.phone;
    },
    CustomerEmailUpdated: (s, e) => {
      s.email = e.email;
    },
    CustomerPhoneUpdated: (s, e) => {
      s.phone = e.phone;
    }
  } satisfies HandlerMap<CustomerEvent, CustomerState>;

  constructor(id: string, snapshot?: CustomerState) {
    super(id, snapshot ?? {});
  }

  register(email: string, name: string, phone?: string) {
    if (this.state.email) {
      throw new Error("Customer already registered");
    }
    this.raise({
      type: "CustomerRegistered",
      version: 1,
      customerId: this.id,
      email,
      name,
      phone
    });
  }

  updateEmail(email: string) {
    if (!this.state.email) {
      throw new Error("Customer not registered");
    }
    this.raise({
      type: "CustomerEmailUpdated",
      version: 1,
      customerId: this.id,
      email
    });
  }

  updatePhone(phone: string) {
    if (!this.state.email) {
      throw new Error("Customer not registered");
    }
    this.raise({
      type: "CustomerPhoneUpdated",
      version: 1,
      customerId: this.id,
      phone
    });
  }

  get email(): string | undefined {
    return this.state.email;
  }

  get name(): string | undefined {
    return this.state.name;
  }
}
