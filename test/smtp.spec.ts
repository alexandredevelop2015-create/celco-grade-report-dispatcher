import { FatalError, RetriableError } from '../src/domain/errors';
import { classifySmtpError } from '../src/notify/smtp-notifier';

describe('classifySmtpError', () => {
  it('4xx e falhas de rede são retriáveis', () => {
    expect(classifySmtpError({ responseCode: 421, message: 'busy' })).toBeInstanceOf(RetriableError);
    expect(classifySmtpError({ code: 'ECONNECTION', message: 'refused' })).toBeInstanceOf(RetriableError);
    expect(classifySmtpError({ code: 'ETIMEDOUT', message: 'timeout' })).toBeInstanceOf(RetriableError);
  });
  it('5xx e envelope inválido são fatais', () => {
    expect(classifySmtpError({ responseCode: 550, message: 'no such user' })).toBeInstanceOf(FatalError);
    expect(classifySmtpError({ code: 'EENVELOPE', message: 'bad address' })).toBeInstanceOf(FatalError);
  });
});
