import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '@/modules/prisma/prisma.service';
import { NotificationService } from '@/modules/notification/notification.service';
import { CreateFuelSessionDto } from '@/types/fuel-session/create-fuel-session.dto';
import { UpdateFuelSessionDto } from '@/types/fuel-session/update-fuel-session.dto';
import { FilterFuelSessionDto } from '@/types/fuel-session/filter-fuel-session.dto';
import { SessionStatus, PaymentStatus } from '@prisma/client';
import { OcppServer } from '../ocpp/ocpp.server';
import { RemoteStartSessionDto } from '@/types/fuel-session/remote-start-session.dto';
import { ClickService } from '../click/click.service';

@Injectable()
export class FuelSessionService {
  constructor(
    private prisma: PrismaService,
    private notificationService: NotificationService,
    @Inject(forwardRef(() => OcppServer))
    private ocppServer: OcppServer,
    private clickService: ClickService
  ) { }

  public async processAutoPayment(sessionId: number) {
    const session = await this.prisma.fuelSession.findUnique({
      where: { id: sessionId },
      include: { user: true }
    });

    if (!session || session.paymentId || session.totalAmount <= 0) return;

    try {
      const result = await this.clickService.payWithToken(session.userId, session.totalAmount);
      if (result.success) {
        await this.prisma.fuelSession.update({
          where: { id: sessionId },
          data: { paymentId: result.transactionId }
        });
      }
    } catch (e) {
      console.error(`Automatic payment failed for session ${sessionId}: ${e.message}`);
    }
  }
  async createForUser(userId: number, dto: CreateFuelSessionDto) {
    return this.prisma.fuelSession.create({
      data: {
        userId,
        fuelStationId: dto.fuelStationId,
        fuelPumpId: dto.fuelPumpId,
        fuelTypeId: dto.fuelTypeId,
        quantity: dto.quantity ?? 0,
        unit: dto.unit,
        pricePerUnit: dto.pricePerUnit ?? 0,
        totalAmount: dto.totalAmount ?? 0,
        paymentId: dto.paymentId,
        status: dto.status ?? SessionStatus.PENDING,
        startTime: dto.startTime ? new Date(dto.startTime) : new Date(),
      },
    });
  }

  async adminCreate(dto: CreateFuelSessionDto) {
    if (!dto.userId)
      throw new ForbiddenException('userId is required for admin create');
    return this.prisma.fuelSession.create({
      data: {
        userId: dto.userId,
        fuelStationId: dto.fuelStationId,
        fuelPumpId: dto.fuelPumpId,
        fuelTypeId: dto.fuelTypeId,
        quantity: dto.quantity ?? 0,
        unit: dto.unit,
        pricePerUnit: dto.pricePerUnit ?? 0,
        totalAmount: dto.totalAmount ?? 0,
        paymentId: dto.paymentId,
        status: dto.status ?? SessionStatus.PENDING,
        startTime: dto.startTime ? new Date(dto.startTime) : new Date(),
      },
    });
  }
  async findAllForUser(userId: number, query: FilterFuelSessionDto) {
    const { page = 1, limit = 10, status, from, to } = query;
    const where: any = { userId };
    if (status) where.status = status;

    if (from || to) {
      where.startTime = {};
      if (from) where.startTime.gte = new Date(from);
      if (to) where.startTime.lte = new Date(to);
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.fuelSession.findMany({
        where,
        orderBy: { startTime: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.fuelSession.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  async adminFindAll(query: FilterFuelSessionDto) {
    const {
      page = 1,
      limit = 10,
      status,
      userId,
      fuelStationId,
      fuelPumpId,
      fuelTypeId,
      from,
      to,
    } = query;
    const where: any = {};
    if (status) where.status = status;
    if (userId) where.userId = userId;
    if (fuelStationId) where.fuelStationId = fuelStationId;
    if (fuelPumpId) where.fuelPumpId = fuelPumpId;
    if (fuelTypeId) where.fuelTypeId = fuelTypeId;

    if (from || to) {
      where.startTime = {};
      if (from) where.startTime.gte = new Date(from);
      if (to) where.startTime.lte = new Date(to);
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.fuelSession.findMany({
        where,
        orderBy: { startTime: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.fuelSession.count({ where }),
    ]);
    return { items, total, page, limit };
  }
  async findOneForUser(userId: number, id: number) {
    const item = await this.prisma.fuelSession.findUnique({
      where: { id },
    });
    if (!item || item.userId !== userId)
      throw new NotFoundException('Session not found');
    return item;
  }

  async adminFindOne(id: number) {
    const item = await this.prisma.fuelSession.findUnique({
      where: { id },
    });
    if (!item) throw new NotFoundException('Session not found');
    return item;
  }

  async adminUpdate(id: number, dto: UpdateFuelSessionDto) {
    const existing = await this.adminFindOne(id);
    const updated = await this.prisma.fuelSession.update({
      where: { id },
      data: {
        fuelStationId: dto.fuelStationId,
        fuelPumpId: dto.fuelPumpId,
        fuelTypeId: dto.fuelTypeId,
        quantity: dto.quantity,
        unit: dto.unit,
        pricePerUnit: dto.pricePerUnit,
        totalAmount: dto.totalAmount,
        paymentId: dto.paymentId,
        status: dto.status,
        startTime: dto.startTime ? new Date(dto.startTime) : undefined,
        endTime: dto.endTime ? new Date(dto.endTime) : undefined,
      },
    });

    if (existing.status !== updated.status && updated.status === SessionStatus.COMPLETED) {
      this.processAutoPayment(updated.id); // Background trigger
      try {
        await this.notificationService.sendToUser(updated.userId, {
          title: 'Fueling Completed',
          body: 'Sizning yoqilg\'i quyish jarayoni yakunlandi',
          type: 'FUEL_SESSION_COMPLETED',
          data: { sessionId: updated.id },
        });
      } catch (e) {
        // ignore notification errors
      }
    }

    return updated;
  }

  async adminRemove(id: number) {
    await this.adminFindOne(id);
    await this.prisma.fuelSession.delete({ where: { id } });
    return { success: true };
  }

  async confirmSession(id: number, paymentId?: number) {
    const session = await this.adminFindOne(id);
    if (session.status !== SessionStatus.PENDING) {
      throw new ForbiddenException('Only PENDING sessions can be confirmed');
    }

    const updated = await this.prisma.fuelSession.update({
      where: { id },
      data: {
        status: SessionStatus.CONFIRMED,
        paymentId: paymentId ?? session.paymentId,
      },
    });

    if (!updated.paymentId) {
        this.processAutoPayment(updated.id);
    }

    return updated;
  }

  async remoteStartSession(userId: number, dto: RemoteStartSessionDto) {
    const fuelPump = await this.prisma.fuelPump.findUnique({
      where: { id: dto.fuelPumpId },
    });

    if (!fuelPump) throw new NotFoundException('Fuel pump not found');

    const stationId = fuelPump.stationId;

    // Pre-create the session
    const session = await this.prisma.fuelSession.create({
      data: {
        fuelStationId: stationId,
        fuelPumpId: fuelPump.id,
        fuelTypeId: 1, // Placeholder: default fuel type (e.g., AI-80 or first found)
        userId,
        userCarId: dto.userCarId ?? null,
        status: SessionStatus.DISPENSING,
        quantity: 0,
        totalAmount: 0,
        startTime: new Date(),
      },
    });

    try {
      await this.ocppServer.sendCallToStation(stationId, 'RemoteStartTransaction', {
        connectorId: fuelPump.fuelPumpNumber,
        idTag: userId.toString()
      });

      return {
        success: true,
        sessionId: session.id,
        message: 'Remote start command dispatched via OCPP',
      };
    } catch (e) {
      await this.prisma.fuelSession.delete({ where: { id: session.id } }).catch(() => { });
      throw new ForbiddenException(`Failed to connect to station: ${e.message}`);
    }
  }

  async remoteStopSession(userId: number, sessionId: number) {
    const session = await this.prisma.fuelSession.findUnique({
      where: { id: sessionId },
      include: { fuelPump: true }
    });

    if (!session) throw new NotFoundException('Session not found');
    if (session.userId !== userId) throw new ForbiddenException('Not your session');

    const stationId = session.fuelPump.stationId;

    try {
      await this.ocppServer.sendCallToStation(stationId, 'RemoteStopTransaction', {
        transactionId: session.id
      });

      return {
        success: true,
        sessionId: session.id,
        message: 'Remote stop command dispatched via OCPP'
      };
    } catch (e) {
      throw new ForbiddenException(`Failed to connect to station: ${e.message}`);
    }
  }
}
