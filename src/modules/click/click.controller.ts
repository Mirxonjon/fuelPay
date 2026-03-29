import { Controller, Post, Get, Delete, Param, ParseIntPipe, Body, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { ClickService } from './click.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Request } from 'express';

import { AddCardDto, VerifyCardDto, PayWithTokenDto } from '../../types/click/click.dto';

@ApiTags('Click Payments')
@Controller('click')
export class ClickController {
    constructor(private readonly clickService: ClickService) { }

    // /click/invoice removed - no wallets to top up


    // Click Webhook (Public, secured by Click MD5 signature)
    @Post('callback')
    @ApiOperation({ summary: 'Click Webhook for Prepare/Complete actions' })
    @ApiHeader({ name: 'click_sign_string', description: 'MD5 hash from Click' })
    async clickCallback(@Body() body: any) {
        return this.clickService.handleCallback(body);
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
        return this.clickService.payWithToken(userId, dto.amount);
    }

    @Delete('cards/:id')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Delete a saved card by ID' })
    async deleteCard(@Req() req: Request, @Param('id', ParseIntPipe) cardId: number) {
        const userId = (req as any).user.sub;
        return this.clickService.deleteCard(userId, cardId);
    }
}
