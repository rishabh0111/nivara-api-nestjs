import { ValidationPipe } from '@nestjs/common';
import { ValidationError } from 'class-validator';
import { AppException, ErrorDetail } from './app-exception';

/** The constraint key class-validator uses for `forbidNonWhitelisted` rejections. */
const UNKNOWN_PROPERTY = 'whitelistValidation';

/**
 * The global validation pipe.
 *
 * `whitelist` strips undeclared properties and `forbidNonWhitelisted` turns
 * them into an error, so a stray field is reported rather than silently
 * dropped. Silently ignoring an undeclared field accepts a request the caller
 * thinks did something it did not.
 *
 * Unknown *query* parameters are rejected earlier, by `UnknownQueryParamsGuard`
 * — that guard covers routes which bind no DTO at all, which this pipe cannot
 * see. What reaches here is a body or path parameter, so an undeclared property
 * is a validation failure (422) rather than the query-scoped `invalid_filter`.
 */
export const buildValidationPipe = (): ValidationPipe =>
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: toAppException,
  });

const toAppException = (errors: ValidationError[]): AppException =>
  new AppException(
    'validation_failed',
    'The request failed validation.',
    flatten(errors),
  );

/**
 * class-validator nests errors by object graph. The envelope reports a flat
 * list, so nested fields are reported by their dotted path.
 */
const flatten = (errors: ValidationError[], prefix = ''): ErrorDetail[] =>
  errors.flatMap((error) => {
    const field = prefix ? `${prefix}.${error.property}` : error.property;

    const own = Object.entries(error.constraints ?? {}).map(
      ([constraint, issue]): ErrorDetail => ({
        field,
        issue:
          constraint === UNKNOWN_PROPERTY
            ? 'is not a recognised property'
            : issue,
      }),
    );

    return [...own, ...flatten(error.children ?? [], field)];
  });
