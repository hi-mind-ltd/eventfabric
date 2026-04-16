export type UserRegisteredV2 = {
  type: "UserRegistered";
  version: 2;
  userId: string;
  email: string;
  displayName: string;
};

export type UserEmailChangedV1 = {
  type: "UserEmailChanged";
  version: 1;
  userId: string;
  email: string;
};

export type UserEvent = UserRegisteredV2 | UserEmailChangedV1;
