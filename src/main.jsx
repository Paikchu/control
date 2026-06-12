import React from 'react';
import { createRoot } from 'react-dom/client';
import { PortfolioApp } from './views/PortfolioApp.jsx';
import './styles.css';

// 应用入口。当前产品形态只挂载持仓工作台（PortfolioApp）；
// 回测工作台保留在 src/views/BacktestView.jsx，挂载即可恢复。
createRoot(document.getElementById('root')).render(<PortfolioApp />);
