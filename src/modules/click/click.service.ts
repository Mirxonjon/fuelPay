import { Injectable, Logger, BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentStatus, SessionStatus } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class ClickService {
    private readonly logger = new Logger(ClickService.name);

    // Constants
    private readonly CLICK_API_URL = 'https://api.click.uz/v2/merchant/card_token';

    constructor(
        private readonly config: ConfigService,
        private readonly prisma: PrismaService,
    ) { }

    private get ENV() {
        return {
            MERCHANT_ID: this.config.get<string>('CLICK_MERCHANT_ID'),
            SERVICE_ID: this.config.get<string>('CLICK_SERVICE_ID'),
            MERCHANT_USER_ID: this.config.get<string>('CLICK_MERCHANT_USER_ID'),
            SECRET_KEY: this.config.get<string>('CLICK_SECRET_KEY'),
        };
    }

    // 1. Signature Validation Helper
    private validateSignature(data: any, action: number): boolean {
        const {
            click_trans_id,
            service_id,
            merchant_trans_id,
            amount,
            sign_time,
            sign_string,
            merchant_prepare_id,
        } = data;

        const { SECRET_KEY } = this.ENV;
        const isComplete = action === 1;

        // Payload format for Click: 
        // click_trans_id + service_id + secret_key + merchant_trans_id + (merchant_prepare_id if action=1) + amount + action + sign_time
        const payload = `${click_trans_id}${service_id}${SECRET_KEY}${merchant_trans_id}${isComplete ? merchant_prepare_id : ''}${amount}${action}${sign_time}`;
        const md5Hash = crypto.createHash('md5').update(payload).digest('hex');

        return md5Hash === sign_string;
    }

    // 2. Click Webhook: PREPARE (action=0)
    async prepare(data: any) {
        const { click_trans_id, merchant_trans_id, amount, action } = data;

        if (!this.validateSignature(data, 0)) {
            this.logger.error('Invalid signature for Click Prepare', { received: data.sign_string });
            return { error: -1, error_note: 'SIGN CHECK FAILED' };
        }

        const txId = parseInt(merchant_trans_id);
        if (isNaN(txId)) return { error: -5, error_note: 'INVALID MERCHANT TRANS ID' };

        const transaction = await this.prisma.paymentTransaction.findUnique({
            where: { id: txId },
        });

        if (!transaction) return { error: -6, error_note: 'TRANSACTION NOT FOUND' };
        if (transaction.amount !== parseFloat(amount)) return { error: -2, error_note: 'INVALID AMOUNT' };

        return {
            click_trans_id,
            merchant_trans_id,
            merchant_prepare_id: txId,
            error: 0,
            error_note: 'Success',
        };
    }

    // 3. Click Webhook: COMPLETE (action=1)
    async complete(data: any) {
        const { click_trans_id, merchant_trans_id, amount, error, action, merchant_prepare_id } = data;

        if (!this.validateSignature(data, 1)) {
            this.logger.error('Invalid signature for Click Complete', { received: data.sign_string });
            return { error: -1, error_note: 'SIGN CHECK FAILED' };
        }

        const txId = parseInt(merchant_trans_id);
        const transaction = await this.prisma.paymentTransaction.findUnique({
            where: { id: txId },
            include: { FuelSession: true }
        });

        if (!transaction) return { error: -6, error_note: 'TRANSACTION NOT FOUND' };

        if (transaction.status === PaymentStatus.SUCCESS) {
            return { error: -4, error_note: 'ALREADY PAID' };
        }

        const isSuccess = parseInt(error) === 0;
        const status = isSuccess ? PaymentStatus.SUCCESS : PaymentStatus.FAILED;

        // Perform Update in Transaction
        await this.prisma.paymentTransaction.update({
            where: { id: txId },
            data: {
                status,
                externalId: click_trans_id.toString(),
                errorMessage: isSuccess ? null : 'Transaction failed or cancelled by Click'
            }
        });

        return {
            click_trans_id,
            merchant_trans_id,
            merchant_confirm_id: txId,
            error: 0,
            error_note: 'Success',
        };
    }

    // 4. User Transaction History
    async getTransactions(userId: number) {
        return this.prisma.paymentTransaction.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            include: {
                FuelSession: {
                    include: {
                        fuelStation: { select: { title: true } },
                        fuelType: { select: { name: true } }
                    }
                }
            }
        });
    }

    private getAuthHeaders() {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const { MERCHANT_USER_ID, SECRET_KEY } = this.ENV;

        const signature = crypto.createHash('sha1').update(timestamp + SECRET_KEY).digest('hex');
        const authHeader = `${MERCHANT_USER_ID}:${signature}:${timestamp}`;

        return {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Auth': authHeader,
        };
    }

    // 5. SECURE CARD SAVING: ADD CARD
    async createCardToken(userId: number, cardNumber: string, expireDate: string) {
        const { SERVICE_ID } = this.ENV;

        const existing = await this.prisma.card.findFirst({
            where: { userId, last4: this.getLast4(cardNumber) }
        });
        if (existing && existing.isActive) {
            throw new BadRequestException('Card already saved');
        }

        const payload = {
            service_id: parseInt(SERVICE_ID),
            card_number: cardNumber,
            expire_date: expireDate,
        };

        try {
            const res = await fetch(`${this.CLICK_API_URL}/request`, {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(payload),
            });
            const data = await res.json() as any;

            if (data.error_code !== 0) {
                throw new BadRequestException(data.error_note || 'Card registration failed');
            }

            const token = data.card_token;

            const card = await this.prisma.card.upsert({
                where: { token },
                update: {},
                create: {
                    userId,
                    token,
                    last4: this.getLast4(cardNumber),
                    isActive: false,
                },
            });

            return { success: true, message: 'SMS code sent', phone: data.phone_number, cardId: card.id };
        } catch (e) {
            this.logger.error('Click Add Card Error', e);
            throw new HttpException(e.message, HttpStatus.BAD_REQUEST);
        }
    }

    // 6. VERIFY SMS CODE
    async verifyCardToken(userId: number, cardId: number, smsCode: string) {
        const { SERVICE_ID } = this.ENV;

        const card = await this.prisma.card.findUnique({ where: { id: cardId } });
        if (!card || card.userId !== userId) {
            throw new BadRequestException('Card not found');
        }

        const payload = {
            service_id: parseInt(SERVICE_ID),
            card_token: card.token,
            sms_code: smsCode,
        };

        try {
            const res = await fetch(`${this.CLICK_API_URL}/verify`, {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(payload),
            });
            const data = await res.json() as any;

            if (data.error_code !== 0) {
                throw new BadRequestException(data.error_note || 'Card verification failed');
            }

            await this.prisma.card.update({
                where: { id: cardId },
                data: { isActive: true },
            });

            return { success: true, message: 'Card verified successfully' };
        } catch (e) {
            this.logger.error('Click Verify Card Error', e);
            throw new HttpException(e.message, HttpStatus.BAD_REQUEST);
        }
    }

    // 7. PAY WITH SAVED TOKEN
    async payWithToken(userId: number, cardId: number | undefined, amount: number) {
        if (amount <= 0) throw new BadRequestException('Invalid amount');

        let card;
        if (cardId) {
            card = await this.prisma.card.findFirst({ where: { id: cardId, userId } });
        } else {
            card = await this.prisma.card.findFirst({ where: { userId, isActive: true }, orderBy: { createdAt: 'desc' } });
        }
        if (!card || !card.isActive) {
            throw new BadRequestException('No active card found for user');
        }

        const tx = await this.prisma.paymentTransaction.create({
            data: {
                cardId: card.id,
                userId,
                amount,
                provider: 'CLICK',
                status: PaymentStatus.PENDING,
            },
        });

        const { SERVICE_ID } = this.ENV;
        const payload = {
            service_id: parseInt(SERVICE_ID),
            card_token: card.token,
            amount: amount,
            merchant_trans_id: tx.id.toString(),
        };

        try {
            const res = await fetch(`${this.CLICK_API_URL}/payment`, {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(payload),
            });
            const data = await res.json() as any;

            if (data.error_code !== 0) {
                await this.prisma.paymentTransaction.update({
                    where: { id: tx.id },
                    data: { 
                        status: PaymentStatus.FAILED,
                        errorCode: data.error_code.toString(),
                        errorMessage: data.error_note
                    },
                });
                throw new BadRequestException(data.error_note || 'Payment failed');
            }

            await this.prisma.paymentTransaction.update({
                where: { id: tx.id },
                data: { 
                    status: PaymentStatus.SUCCESS,
                    externalId: data.click_trans_id?.toString()
                },
            });

            return { success: true, message: 'Payment successful', transactionId: tx.id };
        } catch (e) {
            this.logger.error('Click Pay With Token Error', e);
            throw new HttpException(e.message, HttpStatus.BAD_REQUEST);
        }
    }

    async getSavedCards(userId: number) {
        const cards = await this.prisma.card.findMany({
            where: { userId, isActive: true },
            select: { id: true, last4: true, createdAt: true },
        });
        return cards;
    }

    // 8. DELETE SAVED CARD
    async deleteCard(userId: number, cardId: number) {
        const card = await this.prisma.card.findUnique({ where: { id: cardId } });

        if (!card || card.userId !== userId) {
            throw new BadRequestException('Card not found or access denied');
        }

        await this.prisma.card.delete({ where: { id: cardId } });

        return { success: true, message: 'Card deleted successfully' };
    }

    private getLast4(cardNumber: string) {
        return cardNumber.slice(-4);
    }
}
