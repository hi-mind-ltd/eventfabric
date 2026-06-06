export type CustomerRegisteredV1 = {
  type: "CustomerRegistered";
  version: 1;
  customerId: string;
  email: string;
  name: string;
  phone?: string;
};

export type CustomerEmailUpdatedV1 = {
  type: "CustomerEmailUpdated";
  version: 1;
  customerId: string;
  email: string;
};

export type CustomerPhoneUpdatedV1 = {
  type: "CustomerPhoneUpdated";
  version: 1;
  customerId: string;
  phone: string;
};

export type CustomerEvent =
  | CustomerRegisteredV1
  | CustomerEmailUpdatedV1
  | CustomerPhoneUpdatedV1;

// Factory functions — type and version are baked in
export const CustomerRegistered = (data: Omit<CustomerRegisteredV1, "type" | "version">): CustomerRegisteredV1 =>
  ({ type: "CustomerRegistered", version: 1, ...data });

export const CustomerEmailUpdated = (data: Omit<CustomerEmailUpdatedV1, "type" | "version">): CustomerEmailUpdatedV1 =>
  ({ type: "CustomerEmailUpdated", version: 1, ...data });

export const CustomerPhoneUpdated = (data: Omit<CustomerPhoneUpdatedV1, "type" | "version">): CustomerPhoneUpdatedV1 =>
  ({ type: "CustomerPhoneUpdated", version: 1, ...data });
