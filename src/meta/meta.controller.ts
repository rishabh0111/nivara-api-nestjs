import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ERROR_CATALOG, ErrorCode } from 'src/common/errors/error-codes';
import { Public } from '../auth/auth.guard';
import { ErrorCodeDto } from './error-code.dto';

@ApiTags('meta')
@Controller('meta')
// The error catalog is a published contract, and a client needs it precisely
// when it is working out how to authenticate. Nothing here is tenant data.
@Public()
export class MetaController {
  /**
   * The error catalog, served from the same constant the exception filter
   * throws from.
   *
   * Publishing it here rather than in a side-car document means a client can
   * check its error handling against the running server, and the catalog cannot
   * drift from what the server actually emits.
   */
  @Get('error-codes')
  @ApiOperation({
    summary: 'The closed catalog of machine-readable error codes',
    description:
      'Every non-2xx response carries one of these codes in `error.code`. The list is closed: a code not here is never returned.',
  })
  @ApiOkResponse({ type: [ErrorCodeDto] })
  errorCodes(): ErrorCodeDto[] {
    return (Object.keys(ERROR_CATALOG) as ErrorCode[]).map((code) => ({
      code,
      status: ERROR_CATALOG[code].status,
      description: ERROR_CATALOG[code].description,
    }));
  }
}
