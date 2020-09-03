import {
  OutPoint,
  Script,
  CellOutput,
  Transaction,
} from "@ckb-lumos/base/lib/core";
import { TransactionSkeletonType } from "@ckb-lumos/helpers";
export interface CkbSimpleAccountConfig {
  validator: Buffer;
  generator: Buffer;
  validatorOutpoint: OutPoint;
  typeScript: Script;
  lockScript?: Script;
  capacity: number;
}

export interface SparseMerkleTree {
  rootHash: Buffer;
  leaves: Object;
  branches: Object;
}

export declare class CkbSimpleAccount {
  constructor(
    config: CkbSimpleAccountConfig,
    tree: SparseMerkleTree,
    lastCell?: [OutPoint, CellOutput, Buffer]
  );

  generate(program: Buffer): TransactionSkeletonType;

  advance(transaction: Transaction): void;

  restoreFromTransactions(
    config: CkbSimpleAccountConfig,
    transactions: Array<Transaction>,
    consumeAllTransactions: boolean
  ): void;
}
