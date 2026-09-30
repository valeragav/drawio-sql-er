'use strict';

// Понятные сообщения об ошибках подключения к PostgreSQL и безопасная запись адреса
// базы в журнал (без пользователя и пароля). Общие для моста npm start и сервера Docker.

const MESSAGES = {
  ECONNREFUSED: 'Сервер не отвечает — проверьте хост и порт, запущен ли PostgreSQL',
  ENOTFOUND: 'Хост не найден',
  ETIMEDOUT: 'Превышено время ожидания подключения',
  '28P01': 'Неверный пользователь или пароль',
  '3D000': 'База данных не найдена',
  '28000': 'Доступ запрещён (pg_hba.conf)',
  '57014': 'База слишком долго отвечает на запрос к каталогу (больше 30 с)',
  '42501': 'Нет прав на чтение каталога базы'
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// inDocker — сервер работает в контейнере: там localhost — сам контейнер, а не компьютер.
function humanError(err, url, inDocker = false) {
  let message;
  if (/Query read timeout/i.test(err.message)) message = MESSAGES['57014'];
  else if (/timeout expired|Connection terminated due to connection timeout/i.test(err.message)) message = MESSAGES.ETIMEDOUT;
  else message = MESSAGES[err.code] || err.message;

  const unreachable = message === MESSAGES.ECONNREFUSED || message === MESSAGES.ETIMEDOUT;
  if (inDocker && unreachable && LOCAL_HOSTS.has(hostOf(url))) {
    message += '. В Docker «localhost» — это сам контейнер: для базы на этом компьютере ' +
      'укажите хост host.docker.internal';
  }
  return message;
}

function safeHost(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return '(строка подключения)';
  }
}

module.exports = { humanError, safeHost };
