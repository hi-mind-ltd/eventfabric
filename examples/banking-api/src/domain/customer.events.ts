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
