import "mocha";
import chaiAsPromised = require("chai-as-promised");
import { use as chaiUse, expect } from "chai";
import BigNumber from "bignumber.js";

import { RpcClient } from "./core/rpc-client";
import {
	WALLET_TRANSFER_ADDRESS_2,
	unbondAndWithdrawStake,
} from "./core/setup";
import {
	newWalletRequest,
	newCreateWalletRequest,
	rawWalletRequest,
	generateWalletName,
	newZeroFeeRpcClient,
	newWithFeeRpcClient,
	shouldTest,
	FEE_SCHEMA,
	newZeroFeeTendermintClient,
	newWithFeeTendermintClient,
	asyncMiddleman,
	TRANSACTION_HISTORY_LIMIT,
	DEFAULT_PASSPHRASE,
} from "./core/utils";
import { TendermintClient } from "./core/tendermint-client";
import { waitTxIdConfirmed, syncWallet } from "./core/rpc";
import {
	expectTransactionShouldBe,
	TransactionDirection,
	getFirstElementOfArray,
} from "./core/transaction-utils";
chaiUse(chaiAsPromised);

describe("HDWallet Restore transaction", () => {
	let zeroFeeRpcClient: RpcClient;
	let zeroFeeTendermintClient: TendermintClient;
	let withFeeRpcClient: RpcClient;
	let withFeeTendermintClient: TendermintClient;
	before(async () => {
		await unbondAndWithdrawStake();
		zeroFeeRpcClient = newZeroFeeRpcClient();
		zeroFeeTendermintClient = newZeroFeeTendermintClient();
		withFeeRpcClient = newWithFeeRpcClient();
		withFeeTendermintClient = newWithFeeTendermintClient();
	});

	describe("Zero Fee", () => {
		if (!shouldTest(FEE_SCHEMA.ZERO_FEE)) {
			return;
		}
		it("cannot send funds larger than wallet balance", async () => {
			const walletRequest = await newWalletRequest(zeroFeeRpcClient, "Default", DEFAULT_PASSPHRASE);

			const totalCROSupply = "10000000000000000000";
			return expect(
				zeroFeeRpcClient.request("wallet_sendToAddress", [
					walletRequest,
					WALLET_TRANSFER_ADDRESS_2,
					totalCROSupply,
					[],
				]),
			).to.eventually.rejectedWith("Insufficient balance");
		});

		it("can transfer funds between two wallets", async function() {
			this.timeout(300000);

			const receiverWalletName = generateWalletName("Receive");
			const senderWalletRequest = await newWalletRequest(zeroFeeRpcClient, "Default", DEFAULT_PASSPHRASE);
			const receiverCreateWalletRequest = newCreateWalletRequest(receiverWalletName, DEFAULT_PASSPHRASE);
			const transferAmount = "1000";

			const receiveCreateResponse = await asyncMiddleman(
				zeroFeeRpcClient.request("wallet_restore", [receiverCreateWalletRequest,"benefit motor depth mercy side night winner cube battle sting mandate fly husband beauty walnut beef night stem motion trouble agent degree cricket forest"]),
				"Error when recovering receiver hdwallet",
			);
			const receiverWalletRequest = rawWalletRequest(receiverWalletName, receiveCreateResponse);

			const senderWalletTransactionListBeforeSend = await asyncMiddleman(
				zeroFeeRpcClient.request("wallet_transactions", [senderWalletRequest, 0, TRANSACTION_HISTORY_LIMIT, true]),
				"Error when retrieving sender wallet transactions before send",
			);
			const senderWalletBalanceBeforeSend = await asyncMiddleman(
				zeroFeeRpcClient.request("wallet_balance", [senderWalletRequest]),
				"Error when retrieving sender wallet balance before send",
			);

			const receiverWalletTransferAddress = await asyncMiddleman(
				zeroFeeRpcClient.request("wallet_createTransferAddress", [
					receiverWalletRequest,
				]),
				"Error when creating receiver transfer address",
			);
			const receiverWalletTransactionListBeforeReceive = await asyncMiddleman(
				zeroFeeRpcClient.request("wallet_transactions", [receiverWalletRequest, 0, TRANSACTION_HISTORY_LIMIT, true]),
				"Error when retrieving receiver wallet transactions before receive",
			);
			const receiverWalletBalanceBeforeReceive = await asyncMiddleman(
				zeroFeeRpcClient.request("wallet_balance", [receiverWalletRequest]),
				"Error when retrieving reciever wallet balance before receive",
			);
			const receiverViewKey = await asyncMiddleman(
				zeroFeeRpcClient.request("wallet_getViewKey", [receiverWalletRequest, false]),
				"Error when retrieving receiver view key",
			);

			const txId = await asyncMiddleman(
				zeroFeeRpcClient.request("wallet_sendToAddress", [
					senderWalletRequest,
					receiverWalletTransferAddress,
					transferAmount,
					[receiverViewKey],
				]),
				"Error when trying to send funds from sender to receiver",
			);
			expect(txId.length).to.eq(
				64,
				"wallet_sendToAddress should return transaction id",
			);

			// before sync, the sender's balance is pending
			const senderWalletBalanceBeforeSync = await asyncMiddleman(
				zeroFeeRpcClient.request("wallet_balance", [senderWalletRequest]),
				"Error when retrieving sender wallet balance before sync",
			);
			const returnAmount = new BigNumber(senderWalletBalanceBeforeSend.total)
				.minus(transferAmount)
				.toString(10);
			const expectedBalanceBeforeSync = {
				total: returnAmount,
				pending: returnAmount,
				available: "0",
			};
			expect(senderWalletBalanceBeforeSync).to.deep.eq(
				expectedBalanceBeforeSync,
				"Sender balance should be deducted by transfer amount before sync",
			);


			await asyncMiddleman(
				waitTxIdConfirmed(zeroFeeTendermintClient, txId),
				"Error when waiting for transaction confirmation",
			);

			// sync
			await asyncMiddleman(
				syncWallet(zeroFeeRpcClient, senderWalletRequest),
				"Error when synchronizing sender wallet",
			);
			await asyncMiddleman(
				syncWallet(zeroFeeRpcClient, receiverWalletRequest),
				"Error when synchronizing receiver wallet",
			);

			const senderWalletTransactionListAfterSend = await asyncMiddleman(
				zeroFeeRpcClient.request("wallet_transactions", [senderWalletRequest, 0, TRANSACTION_HISTORY_LIMIT, true]),
				"Error when retrieving sender wallet transactions after send",
			);

			expect(senderWalletTransactionListAfterSend.length).to.eq(
				senderWalletTransactionListBeforeSend.length + 1,
				"Sender should have one extra transaction record",
			);
			const senderWalletLastTransaction = getFirstElementOfArray(
				senderWalletTransactionListAfterSend,
			);

			expectTransactionShouldBe(
				senderWalletLastTransaction,
				{
					direction: TransactionDirection.OUTGOING,
					amount: new BigNumber(transferAmount),
				},
				"Sender should have one Outgoing transaction",
			);

			// after sync, the pending balance will become available
			const senderWalletBalanceAfterSync = await asyncMiddleman(
				zeroFeeRpcClient.request("wallet_balance", [senderWalletRequest]),
				"Error when retrieving sender wallet balance after send",
			);
			const expectedBalanceAfterSync = {
				total: returnAmount,
				pending: "0",
				available: returnAmount,
			};
			expect(senderWalletBalanceAfterSync).to.deep.eq(
				expectedBalanceAfterSync,
				"Sender balance should be deducted by transfer amount after sync",
			);

			const receiverWalletTransactionListAfterReceive = await asyncMiddleman(
				zeroFeeRpcClient.request("wallet_transactions", [receiverWalletRequest, 0, TRANSACTION_HISTORY_LIMIT, true]),
				"Error when retrieving receiver wallet transaction after receive",
			);
			expect(receiverWalletTransactionListAfterReceive.length).to.eq(
				receiverWalletTransactionListBeforeReceive.length + 1,
				"Receiver should have one extra transaction record",
			);

			const receiverWalletLastTransaction = getFirstElementOfArray(
				receiverWalletTransactionListAfterReceive,
			);
			expectTransactionShouldBe(
				receiverWalletLastTransaction,
				{
					direction: TransactionDirection.INCOMING,
					amount: new BigNumber(transferAmount),
				},
				"Receiver should have one Incoming transaction of the received amount",
			);

			const receiverWalletBalanceAfterReceive = await asyncMiddleman(
				zeroFeeRpcClient.request("wallet_balance", [receiverWalletRequest]),
				"Error when retrieving receiver wallet balance after receive",
			);
			// after sync, the receive's balance will be increased
			const expectedreceiverWalletBalanceAfterReceive = new BigNumber(receiverWalletBalanceBeforeReceive.total)
				.plus(transferAmount)
				.toString(10);
			const expectedBalanceAfterReceive = {
				total: transferAmount,
				pending: "0",
				available: transferAmount,
			};
			expect(receiverWalletBalanceAfterReceive).to.deep.eq(
				expectedBalanceAfterReceive,
				"Receiver balance should be increased by transfer amount",
			);
		});
	});

	describe("With Fee", () => {
		if (!shouldTest(FEE_SCHEMA.WITH_FEE)) {
			return;
		}
		it("can transfer funds between two wallets with fee included", async function() {
			this.timeout(300000);

			const receiverWalletName = generateWalletName("Receive");
			const senderWalletRequest = await newWalletRequest(withFeeRpcClient, "Default", DEFAULT_PASSPHRASE);
			const receiverCreateWalletRequest = newCreateWalletRequest(receiverWalletName, DEFAULT_PASSPHRASE);
			const transferAmount = "1000";

			const receiverCreateResponse = await asyncMiddleman(
				withFeeRpcClient.request("wallet_restore", [receiverCreateWalletRequest,"speed tortoise kiwi forward extend baby acoustic foil coach castle ship purchase unlock base hip erode tag keen present vibrant oyster cotton write fetch"]),
				"Error when recovering receive hdwallet",
			);
			const receiverWalletRequest = rawWalletRequest(receiverWalletName, receiverCreateResponse);




			const senderWalletTransactionListBeforeSend = await asyncMiddleman(
				withFeeRpcClient.request("wallet_transactions", [senderWalletRequest, 0, TRANSACTION_HISTORY_LIMIT, true]),
				"Error when retrieving sender wallet transaction before send",
			);
			const senderWalletBalanceBeforeSend = await asyncMiddleman(
				withFeeRpcClient.request("wallet_balance", [senderWalletRequest]),
				"Error when retrieving sender wallet balance before send",
			);

			const receiverWalletTransferAddress = await asyncMiddleman(
				withFeeRpcClient.request("wallet_createTransferAddress", [
					receiverWalletRequest,
				]),
				"Error when creating receiver transfer address",
			);
			const receiverWalletTransactionListBeforeReceive = await asyncMiddleman(
				withFeeRpcClient.request("wallet_transactions", [receiverWalletRequest, 0, TRANSACTION_HISTORY_LIMIT, true]),
				"Error when retrieving receiver wallet transaction before receive",
			);
			const receiverWalletBalanceBeforeReceive = await asyncMiddleman(
				withFeeRpcClient.request("wallet_balance", [receiverWalletRequest]),
				"Error when retrieving receiver wallet balance before receive",
			);
			const receiverViewKey = await asyncMiddleman(
				withFeeRpcClient.request("wallet_getViewKey", [receiverWalletRequest, false]),
				"Error when retrieving receiver view key",
			);

			const txId = await asyncMiddleman(
				withFeeRpcClient.request("wallet_sendToAddress", [
					senderWalletRequest,
					receiverWalletTransferAddress,
					transferAmount,
					[receiverViewKey],
				]),
				"Error when sending funds from sender to receiver",
			);
			expect(txId.length).to.eq(
				64,
				"wallet_sendToAddress should return transaction id",
			);

			await asyncMiddleman(
				waitTxIdConfirmed(withFeeTendermintClient, txId),
				"Error when waiting for transaction confirmation",
			);

			await asyncMiddleman(
				syncWallet(withFeeRpcClient, senderWalletRequest),
				"Error when synchronizing sender wallet",
			);
			await asyncMiddleman(
				syncWallet(withFeeRpcClient, receiverWalletRequest),
				"Error when synchronizing receiver wallet",
			);

			const senderWalletTransactionListAfterSend = await asyncMiddleman(
				withFeeRpcClient.request("wallet_transactions", [senderWalletRequest, 0, TRANSACTION_HISTORY_LIMIT, true]),
				"Error when retrieving sender wallet transactions after send",
			);
			expect(senderWalletTransactionListAfterSend.length).to.eq(
				senderWalletTransactionListBeforeSend.length + 1,
				"Sender should have one extra transaction record1",
			);
			const senderWalletLastTransaction = getFirstElementOfArray(
				senderWalletTransactionListAfterSend,
			);
			expectTransactionShouldBe(
				senderWalletLastTransaction,
				{
					direction: TransactionDirection.OUTGOING,
					amount: new BigNumber(transferAmount),
				},
				"Sender should have one Outgoing transaction",
			);
			expect(senderWalletLastTransaction.kind).to.eq(
				TransactionDirection.OUTGOING,
			);
			expect(
				new BigNumber(0).isLessThan(new BigNumber(senderWalletLastTransaction.fee)),
			).to.eq(true, "Sender should pay for transfer fee");

			const senderWalletBalanceAfterSend = await asyncMiddleman(
				withFeeRpcClient.request("wallet_balance", [senderWalletRequest]),
				"Error when retrieving sender wallet balance after send",
			);
			expect(
				new BigNumber(senderWalletBalanceAfterSend.total).isLessThan(
					new BigNumber(senderWalletBalanceBeforeSend.available).minus(transferAmount),
				),
			).to.eq(
				true,
				"Sender balance should be deducted by transfer amount and fee",
			);

			const receiverWalletTransactionListAfterReceive = await asyncMiddleman(
				withFeeRpcClient.request("wallet_transactions", [receiverWalletRequest, 0, TRANSACTION_HISTORY_LIMIT, true]),
				"Error when retrieving receiver wallet transactions after receive",
			);
			expect(receiverWalletTransactionListAfterReceive.length).to.eq(
				receiverWalletTransactionListBeforeReceive.length + 1,
				"Receiver should have one extra transaction record",
			);

			const receiverWalletLastTransaction = getFirstElementOfArray(
				receiverWalletTransactionListAfterReceive,
			);
			expectTransactionShouldBe(
				receiverWalletLastTransaction,
				{
					direction: TransactionDirection.INCOMING,
					amount: new BigNumber(transferAmount),
				},
				"Receiver should have one Incoming transaction of the exact received amount",
			);

			const receiverWalletBalanceAfterReceive = await asyncMiddleman(
				withFeeRpcClient.request("wallet_balance", [receiverWalletRequest]),
				"Error when retrieving receiver wallet balance after receive",
			);
			const receiverTotalAmount = new BigNumber(receiverWalletBalanceBeforeReceive.total)
				.plus(transferAmount)
				.toString(10);
			const expectedBalanceAfterReceive = {
				total: receiverTotalAmount,
				available: receiverTotalAmount,
				pending: "0",
			};
			expect(receiverWalletBalanceAfterReceive).to.deep.eq(
				expectedBalanceAfterReceive,
				"Receiver balance should be increased by the exact transfer amount",
			);
		});
	});
});
