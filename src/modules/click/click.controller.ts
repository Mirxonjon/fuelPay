import { Controller, Post, Get, Delete, Param, ParseIntPipe, Body, Req, UseGuards, Res, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { ClickService } from './click.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Request, Response } from 'express';

import { AddCardDto, VerifyCardDto, PayWithTokenDto } from '../../types/click/click.dto';

@ApiTags('Click Payments')
@Controller('click')
export class ClickController {
    constructor(private readonly clickService: ClickService) { }

    // 1. Click Webhook: PREPARE
    @Post('prepare')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Click Webhook for Prepare action' })
    @ApiHeader({ name: 'click_sign_string', description: 'MD5 hash from Click' })
    async clickPrepare(@Body() body: any, @Res() res: Response) {
        try {
            const result = await this.clickService.prepare(body);
            this.logger('CLICK PREPARE', result);
            res.set('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8')
                .send(result);
        } catch (e) {
            res.set('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8')
                .send({ error: -8, error_note: 'UNKNOWN ERROR' });
        }
    }

    // 2. Click Webhook: COMPLETE
    @Post('complete')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Click Webhook for Complete action' })
    @ApiHeader({ name: 'click_sign_string', description: 'MD5 hash from Click' })
    async clickComplete(@Body() body: any, @Res() res: Response) {
        try {
            const result = await this.clickService.complete(body);
            this.logger('CLICK COMPLETE', result);
            res.set('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8')
                .send(result);
        } catch (e) {
            res.set('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8')
                .send({ error: -8, error_note: 'UNKNOWN ERROR' });
        }
    }

    @Get('transactions')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get user payment transactions history' })
    async getTransactions(@Req() req: Request) {
        const userId = (req as any).user.sub;
        return this.clickService.getTransactions(userId);
    }

    @Get('cards')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get saved Click cards' })
    async getCards(@Req() req: Request) {
        const userId = (req as any).user.sub;
        return this.clickService.getSavedCards(userId);
    }

    @Post('cards/add')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Request to add a new card to Click (Tokenization Step 1)' })
    async addCard(@Req() req: Request, @Body() dto: AddCardDto) {
        const userId = (req as any).user.sub;
        return this.clickService.createCardToken(userId, dto.cardNumber, dto.expireDate);
    }

    @Post('cards/verify')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Verify the added card with SMS code (Tokenization Step 2)' })
    async verifyCard(@Req() req: Request, @Body() dto: VerifyCardDto) {
        const userId = (req as any).user.sub;
        return this.clickService.verifyCardToken(userId, dto.cardId, dto.smsCode);
    }

    @Post('cards/pay')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Directly pay for fueling using the saved card' })
    async payWithToken(@Req() req: Request, @Body() dto: PayWithTokenDto) {
        const userId = (req as any).user.sub;
        return this.clickService.payWithToken(userId, dto.cardId, dto.amount);
    }

    @Delete('cards/:id')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Delete a saved card by ID' })
    async deleteCard(@Req() req: Request, @Param('id', ParseIntPipe) cardId: number) {
        const userId = (req as any).user.sub;
        return this.clickService.deleteCard(userId, cardId);
    }

    private logger(title: string, data: any) {
        console.log(`================ ${title} RESPONSE ================`);
        console.log(data);
        console.log('========================================================');
    }
}
