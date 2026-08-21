const message = new URLSearchParams(location.search).get('error');

if (message) {
  document.title = '创建 UI 示意失败';
  document.querySelector('h1')!.textContent = '创建 UI 示意失败';
  document.querySelector('p')!.textContent = message;
  document.querySelector('.progress')?.remove();
}
