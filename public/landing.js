function toggleDark() {
  const dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', dark ? 'dark' : 'light');
}

const params = new URLSearchParams(window.location.search);
if (params.get('error')) {
  document.getElementById('error-msg').textContent = 'Sign-in failed. Please try again.';
}

document.getElementById('signin-btn').addEventListener('click', (e) => {
  e.preventDefault();
  const rememberMe = document.getElementById('remember-me').checked;
  window.location.href = `/auth/google?rememberMe=${rememberMe}`;
});
